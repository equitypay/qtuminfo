import util from 'util'
import secp256k1 from 'secp256k1'
import {BufferReader, BufferWriter} from '..'
import Opcode from './opcode'

const types = {
  UNKNOWN: 'Unknown',
  COINBASE: 'Coinbase',
  PUBKEY_OUT: 'Pay to public key',
  PUBKEY_IN: 'Spend from public key',
  PUBKEYHASH_OUT: 'Pay to public key hash',
  PUBKEYHASH_IN: 'Spend from public key hash',
  SCRIPTHASH_OUT: 'Pay to script hash',
  SCRIPTHASH_IN: 'Spend from script hash',
  MULTISIG_OUT: 'Pay to multisig',
  MULTISIG_IN: 'Spend from multisig',
  DATA_OUT: 'Data push',
  WITNESS_V0_KEYHASH: 'Pay to witness public key hash',
  WITNESS_V0_SCRIPTHASH: 'Pay to witness script hash',
  WITNESS_IN: 'Spend from witness',
  EVM_CONTRACT_CREATE: 'EVM contract create',
  EVM_CONTRACT_CALL: 'EVM contract call',
  EVM_CONTRACT_CREATE_SENDER: 'EVM contract create by sender',
  EVM_CONTRACT_CALL_SENDER: 'EVM contract call by sender',
  CONTRACT_OUT: 'Pay to contract',
  CONTRACT_SPEND: 'Spend from contract'
}

const outputIdentifiers = {
  PUBKEY_OUT: 'isPublicKeyOut',
  PUBKEYHASH_OUT: 'isPublicKeyHashOut',
  MULTISIG_OUT: 'isMultisigOut',
  SCRIPTHASH_OUT: 'isScriptHashOut',
  DATA_OUT: 'isDataOut',
  WITNESS_V0_KEYHASH: 'isWitnessKeyHashOut',
  WITNESS_V0_SCRIPTHASH: 'isWitnessScriptHashOut',
  EVM_CONTRACT_CREATE: 'isEVMContractCreate',
  EVM_CONTRACT_CALL: 'isEVMContractCall',
  EVM_CONTRACT_CREATE_SENDER: 'isEVMContractCreateBySender',
  EVM_CONTRACT_CALL_SENDER: 'isEVMContractCallBySender',
  CONTRACT_OUT: 'isContractOut'
}
const inputIdentifiers = {
  COINBASE: 'isCoinbase',
  PUBKEY_IN: 'isPublicKeyIn',
  PUBKEYHASH_IN: 'isPublicKeyHashIn',
  MULTISIG_IN: 'isMultisigIn',
  SCRIPTHASH_IN: 'isScriptHashIn',
  WITNESS_IN: 'isWitnessIn',
  CONTRACT_SPEND: 'isContractSpend'
}

export class InvalidScriptError extends Error {
  constructor(...args) {
    super(...args)
    Error.captureStackTrace(this, this.constructor)
  }

  get name() {
    return this.constructor.name
  }
}

export default class Script {
  constructor(chunks, {isOutput = false, isInput = false, isCoinbase = false}) {
    this.chunks = chunks
    this._isOutput = isOutput
    this._isInput = isInput
    this._isCoinbase = isCoinbase
  }

  static fromBuffer(buffer, {isOutput = false, isInput = false, isCoinbase = false}) {
    if (isCoinbase) {
      return new Script([{buffer}], {isInput: true, isCoinbase: true})
    }
    if (buffer[0] === Opcode.OP_RETURN) {
      let data = buffer.slice(1)
      return new Script([
        {code: Opcode.OP_RETURN},
        ...data.length ? [{buffer: data}] : []
      ], {isOutput: true})
    }
    let reader = new BufferReader(buffer)
    let chunks = []
    while (!reader.finished) {
      let code = reader.readUInt8()
      if (code > 0 && code < Opcode.OP_PUSHDATA1) {
        let length = code
        let buf = reader.read(length)
        chunks.push({code, buffer: buf})
      } else if (code === Opcode.OP_PUSHDATA1) {
        let length = reader.readUInt8()
        let buf = reader.read(length)
        chunks.push({code, buffer: buf})
      } else if (code === Opcode.OP_PUSHDATA2) {
        let length = reader.readUInt16LE()
        let buf = reader.read(length)
        chunks.push({code, buffer: buf})
      } else if (code === Opcode.OP_PUSHDATA4) {
        let length = reader.readUInt32LE()
        let buf = reader.read(length)
        chunks.push({code, buffer: buf})
      } else {
        chunks.push({code})
      }
    }
    return new Script(chunks, {isOutput, isInput})
  }

  toBuffer() {
    let writer = new BufferWriter()
    this.toBufferWriter(writer)
    return writer.toBuffer()
  }

  toBufferWriter(writer) {
    if (this._isCoinbase) {
      writer.write(this.chunks[0].buffer)
      return
    }
    if (this.isDataOut()) {
      writer.writeUInt8(Opcode.OP_RETURN)
      if (this.chunks.length === 2) {
        writer.write(this.chunks[1].buffer)
      }
      return
    }
    for (let {code, buffer} of this.chunks) {
      writer.writeUInt8(code)
      if (buffer) {
        if (code < Opcode.OP_PUSHDATA1) {
          writer.write(buffer)
        } else if (code === Opcode.OP_PUSHDATA1) {
          writer.writeUInt8(buffer.length)
          writer.write(buffer)
        } else if (code === Opcode.OP_PUSHDATA2) {
          writer.writeUInt16LE(buffer.length)
          writer.write(buffer)
        } else if (code === Opcode.OP_PUSHDATA4) {
          writer.writeUInt32LE(buffer.length)
          writer.write(buffer)
        }
      }
    }
  }

  toString() {
    let chunks = this.chunks.map(({code, buffer}) => {
      if (buffer) {
        return buffer.toString('hex')
      } else if (code in Opcode.reverseMap) {
        return Opcode.reverseMap[code]
      } else {
        return code
      }
    })
    if (['OP_CREATE', 'OP_CALL'].includes(chunks[chunks.length - 1])) {
      for (let i = 0; i < 3; ++i) {
        chunks[i] = Script.parseNumberChunk(chunks[i])
      }
    }
    return chunks.join(' ')
  }

  static parseNumberChunk(chunk) {
    if (/^OP_\d+$/.test(chunk)) {
      return Number.parseInt(chunk.slice(3))
    } else {
      return Number.parseInt(
        Buffer.from(chunk, 'hex')
          .reverse()
          .toString('hex'),
        16
      )
    }
  }

  [util.inspect.custom]() {
    return `<Script ${this.toString()}>`
  }

  isCoinbase() {
    return this._isCoinbase
  }

  isPublicKeyOut() {
    return this.chunks.length === 2
      && this.chunks[0].buffer && secp256k1.publicKeyVerify(this.chunks[0].buffer)
      && this.chunks[1].code === Opcode.OP_CHECKSIG
  }

  isPublicKeyIn() {
    return this.chunks.length === 1
      && this.chunks[0].buffer && this.chunks[0].buffer[0] === 0x30
  }

  isPublicKeyHashOut() {
    return this.chunks.length === 5
      && this.chunks[0].code === Opcode.OP_DUP
      && this.chunks[1].code === Opcode.OP_HASH160
      && this.chunks[2].buffer && this.chunks[2].buffer.length === 20
      && this.chunks[3].code === Opcode.OP_EQUALVERIFY
      && this.chunks[4].code === Opcode.OP_CHECKSIG
  }

  isPublicKeyHashIn() {
    return this.chunks.length === 2
      && this.chunks[0].buffer && this.chunks[0].buffer[0] === 0x30
      && this.chunks[1].buffer && secp256k1.publicKeyVerify(this.chunks[1].buffer)
  }

  isScriptHashOut() {
    return this.chunks.length === 3
      && this.chunks[0].code === Opcode.OP_HASH160
      && this.chunks[1].buffer && this.chunks[1].buffer.length === 20
      && this.chunks[2].code === Opcode.OP_EQUAL
  }

  isScriptHashIn() {
    if (this.chunks.length <= 1) {
      return false
    }
    let redeemBuffer = this.chunks[this.chunks.length - 1].buffer
    if (!redeemBuffer) {
      return false
    }
    let redeemScript = Script.fromBuffer(redeemBuffer, {isOutput: true})
    return redeemScript.isStandard()
  }

  isMultisigOut() {
    return this.chunks.length > 3 && new Opcode(this.chunks[0].code).isSmallInt()
      && this.chunks.slice(1, -2).every(chunk => chunk.buffer)
      && new Opcode(this.chunks[this.chunks.length - 2].code).isSmallInt()
      && this.chunks[this.chunks.length - 1].code === Opcode.OP_CHECKMULTISIG
  }

  isMultisigIn() {
    return this.chunks.length >= 2 && this.chunks[0].code === Opcode.OP_0
      && this.chunks.slice(1).every(chunk => chunk.buffer && isDER(chunk.buffer))
  }

  isDataOut() {
    return this.chunks.length >= 1 && this.chunks[0].code === Opcode.OP_RETURN
      && (
        this.chunks.length === 1
        || this.chunks.length === 2 && this.chunks[1].buffer
      )
  }

  isWitnessKeyHashOut() {
    return this.chunks.length === 2 && this.chunks[0].code === Opcode.OP_0
      && this.chunks[1].buffer && this.chunks[1].buffer.length === 20
  }

  isWitnessScriptHashOut() {
    return this.chunks.length === 2 && this.chunks[0].code === Opcode.OP_0
      && this.chunks[1].buffer && this.chunks[1].buffer.length === 32
  }

  isWitnessIn() {
    if (this.chunks.length === 0) {
      return true
    }
    if (this.chunks.length > 1) {
      return false
    }
    let redeemBuffer = this.chunks[this.chunks.length - 1].buffer
    if (!redeemBuffer) {
      return false
    }
    let redeemScript = Script.fromBuffer(redeemBuffer, {isOutput: true})
    return redeemScript.isStandard()
  }

  isEVMContractCreate() {
    return this.chunks.length === 5
      && (this.chunks[0].code === Opcode.OP_4 || this.chunks[0].buffer && this.chunks[0].buffer[0] === 4)
      && this.chunks[4].code === Opcode.OP_CREATE
  }

  isEVMContractCreateBySender() {
    return this.chunks.length === 9
      && this.chunks[3].code === Opcode.OP_SENDER
      && (this.chunks[4].code === Opcode.OP_4 || this.chunks[4].buffer && this.chunks[4].buffer[0] === 4)
      && this.chunks[8].code === Opcode.OP_CREATE
  }

  isEVMContractCall() {
    return this.chunks.length === 6
      && (this.chunks[0].code === Opcode.OP_4 || this.chunks[0].buffer && this.chunks[0].buffer[0] === 4)
      && this.chunks[5].code === Opcode.OP_CALL
  }

  isEVMContractCallBySender() {
    return this.chunks.length === 10
      && this.chunks[3].code === Opcode.OP_SENDER
      && (this.chunks[4].code === Opcode.OP_4 || this.chunks[4].buffer && this.chunks[4].buffer[0] === 4)
      && this.chunks[9].code === Opcode.OP_CALL
  }

  isContractOut() {
    return this.chunks.length === 6
      && this.chunks[0].buffer && this.chunks[0].buffer[0] === 0
      && this.chunks[5].code === Opcode.OP_CALL
  }

  isContractSpend() {
    return this.chunks.length === 1 && this.chunks[0].code === Opcode.OP_SPEND
  }

  get type() {
    if (this._type) {
      return this._type
    }
    if (this._isOutput) {
      return this._classifyOutput()
    } else if (this._isInput) {
      return this._classifyInput()
    } else {
      return types.UNKNOWN
    }
  }

  _classifyOutput() {
    for (let [type, method] of Object.entries(outputIdentifiers)) {
      if (this[method]()) {
        return types[type]
      }
    }
    return types.UNKNOWN
  }

  _classifyInput() {
    for (let [type, method] of Object.entries(inputIdentifiers)) {
      if (this[method]()) {
        return types[type]
      }
    }
    return types.UNKNOWN
  }

  isStandard() {
    return this.type !== types.UNKNOWN
  }

  isEmpty() {
    return this.chunks.length === 0
  }
}

function isDER(buffer) {
  if (buffer.length < 9 || buffer.length > 73) {
    return false
  } else if (buffer[0] !== 0x30 || buffer[1] !== buffer.length - 3) {
    return false
  }
  let lengthR = buffer[3]
  if (lengthR + 5 >= buffer.length) {
    return false
  }
  let lengthS = buffer[lengthR + 5]
  if (lengthR + lengthS + 7 !== buffer.length) {
    return false
  }
  let R = buffer.slice(4)
  if (buffer[2] !== 2 || lengthR === 0 || R[0] & 0x80) {
    return false
  } else if (lengthR > 1 && R[0] === 0 && !(R[1] & 0x80)) {
    return false
  }
  let S = buffer.slice(lengthR + 6)
  if (buffer[lengthR + 4] !== 2 || lengthS === 0 || S[0] & 0x80) {
    return false
  } else if (lengthS > 1 && S[0] === 0 && !(S[1] & 0x80)) {
    return false
  }
  return true
}

Object.assign(Script, types)
