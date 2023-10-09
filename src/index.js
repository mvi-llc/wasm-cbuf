const ModuleFactory = require("./wasm-cbuf")

const ModulePromise = ModuleFactory()

let Module

// The `metadata.cbuf` definition is bootstrapped so other definitions can be
// read from metadata messages in a cbuf `.cb` file
const METADATA_DEFINITION = {
  name: "cbufmsg::metadata",
  hashValue: 0xbe6738d544ab72c6n,
  definitions: [
    { name: "msg_hash", type: "uint64" },
    { name: "msg_name", type: "string" },
    { name: "msg_meta", type: "string" },
  ],
}

const HEADER_SIZE = 4 + 4 + 8 + 8

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

function ensureLoaded() {
  if (!Module) {
    throw new Error(`wasm-cbuf has not finished loading. Please wait with "await Cbuf.isLoaded"`)
  }
}

/**
 * @typedef {import('@foxglove/message-definition').MessageDefinition} MessageDefinition
 * @typedef {import("@foxglove/message-definition").MessageDefinitionField} MessageDefinitionField
 * @typedef {MessageDefinition & { hashValue: bigint; line: number; column: number; naked: boolean }} CbufMessageDefinition
 */

/**
 * Parse a CBuf `.cbuf` schema into an object containing an error string or a
 * `Map<string, CbufMessageDefinition>`.
 *
 * @param {string} schemaText The schema text to parse. This is the contents of a `.cbuf` file where
 *   all #include statements have been expanded.
 * @returns {{ error?: string; schema: Map<string, CbufMessageDefinition> }}
 *   An object containing the parsed schema as a Map<string, CbufMessageDefinition> mapping fully
 *   qualified message names to their parsed definition, or an error string if parsing failed.
 */
function parseCBufSchema(schemaText) {
  ensureLoaded()
  const result = Module.parseCBufSchema(schemaText)
  if (result.error != undefined) {
    return { error: result.error, schema: new Map() }
  }

  const schema = new Map()
  for (const definition of result.schema) {
    schema.set(definition.name, definition)
  }
  return { schema }
}

/**
 * Takes a parsed schema (`Map<string, CbufMessageDefinition>`) which maps message names to message
 * definitions and returns a new `Map<bigint, CbufMessageDefinition>` mapping hash values to message
 * definitions.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @returns {Map<bigint, CbufMessageDefinition>} Mapping from hash values to message definitions.
 */
function schemaMapToHashMap(schemaMap) {
  const hashMap = new Map()
  for (const definition of schemaMap.values()) {
    hashMap.set(definition.hashValue, definition)
  }
  return hashMap
}

/**
 * Given hash maps from message names and hash values to `CbufMessageDefinition`s, a byte buffer,
 * and optional offset into the buffer, deserialize the buffer into a JavaScript object representing
 * a single non-naked struct message, which includes a message header and message data.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap A map of fully qualified message names to
 *   message definitions obtained from `parseCBufSchema()`.
 * @param {Map<bigint, CbufMessageDefinition>} hashMap A map of hash values to message definitions
 *   obtained from `schemaMapToHashMap()`.
 * @param {ArrayBufferView} data The byte buffer to deserialize from.
 * @param {number | undefined} offset Optional byte offset into the buffer to deserialize from.
 * @returns {{
 *   typeName: string; // The fully qualified message name
 *   size: number; // The size of the message header and message data, in bytes
 *   variant: number; // The message variant
 *   hashValue: bigint; // The hash value of the `.cbuf` message definition
 *   timestamp: number; // A timestamp in seconds since the Unix epoch as a 64-bit float
 *   message: Record<string, unknown> // The deserialized messge data
 * }} A JavaScript object representing the deserialized message header fields and message data.
 */
function deserializeMessage(schemaMap, hashMap, data, offset) {
  let curOffset = offset || 0
  if (curOffset < 0 || curOffset >= data.length) {
    throw new Error(`Invalid offset ${curOffset} for buffer of length ${data.length}`)
  }

  // CBuf layout for a non-naked struct:
  //   CBUF_MAGIC (4 bytes) 0x56444e54
  //   size uint32_t (4 bytes)
  //   hashValue uint64_t (8 bytes)
  //   timestamp double (8 bytes)
  //   message data

  // Create a view into the buffer starting at offset and reset offset to zero
  const view = new DataView(data.buffer, data.byteOffset + curOffset, data.byteLength - curOffset)
  curOffset = 0
  if (view.byteLength < 24) {
    throw new Error(`Buffer too small to contain cbuf header: ${view.byteLength} bytes`)
  }

  // CBUF_MAGIC
  const magic = view.getUint32(curOffset, true)
  curOffset += 4
  if (magic !== 0x56444e54) {
    throw new Error(`Invalid cbuf magic 0x${magic.toString(16)}`)
  }

  // size and variant
  const sizeAndVariant = view.getUint32(curOffset, true)
  const hasVariant = (sizeAndVariant & 0x80000000) >>> 0 == 0x80000000
  const size = hasVariant ? sizeAndVariant & 0x07ffffff : sizeAndVariant & 0x7fffffff
  const variant = hasVariant ? (sizeAndVariant >> 27) & 0x0f : 0
  curOffset += 4
  if (size > view.byteLength) {
    throw new Error(`cbuf size ${size} exceeds buffer of length ${view.byteLength}`)
  }

  // hashValue
  const hashValue = view.getBigUint64(curOffset, true)
  curOffset += 8

  // timestamp
  const timestamp = view.getFloat64(curOffset, true)
  curOffset += 8

  // Look up the message definition by hash value in the schema hash map with a fallback check for
  // the built-in metadata definition
  const msgdef =
    hashValue === METADATA_DEFINITION.hashValue ? METADATA_DEFINITION : hashMap.get(hashValue)
  if (!msgdef) {
    throw new Error(`cbuf hash value ${hashValue} not found in the hash map`)
  }

  // message data
  const message = {}
  curOffset += deserializeNakedMessage(schemaMap, hashMap, msgdef, view, curOffset, message)
  if (curOffset !== size) {
    throw new Error(`cbuf size ${size} does not match decoded size ${curOffset}`)
  }

  return { typeName: msgdef.name, size, variant, hashValue, timestamp, message }
}

/**
 * Deserialize a single naked struct message from a DataView into a JavaScript object.
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {CbufMessageDefinition} msgdef
 * @param {DataView} view
 * @param {number} offset
 * @param {Record<string, unknown>} output
 * @returns {number} The number of bytes consumed from the buffer
 */
function deserializeNakedMessage(schemaMap, hashMap, msgdef, view, offset, output) {
  let innerOffset = 0

  for (const field of msgdef.definitions) {
    if (field.isArray === true) {
      // Array field (fixed or variable length)
      let arrayLength = field.arrayLength
      if (arrayLength == undefined) {
        arrayLength = view.getUint32(offset + innerOffset, true)
        innerOffset += 4
      }

      // The byte offset into the underlying ArrayBuffer we are reading from, for constructing
      // typed arrays
      const bufferOffset = view.byteOffset + offset + innerOffset

      switch (field.type) {
        case "bool":
        case "uint8":
          output[field.name] = typedArray(Uint8Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength
          break
        case "int8":
          output[field.name] = typedArray(Int8Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength
          break
        case "uint16":
          output[field.name] = typedArray(Uint16Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 2
          break
        case "int16":
          output[field.name] = typedArray(Int16Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 2
          break
        case "uint32":
          output[field.name] = typedArray(Uint32Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 4
          break
        case "int32":
          output[field.name] = typedArray(Int32Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 4
          break
        case "uint64":
          // eslint-disable-next-line no-undef
          output[field.name] = typedArray(BigUint64Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 8
          break
        case "int64":
          // eslint-disable-next-line no-undef
          output[field.name] = typedArray(BigInt64Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 8
          break
        case "float32":
          output[field.name] = typedArray(Float32Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 4
          break
        case "float64":
          output[field.name] = typedArray(Float64Array, view.buffer, bufferOffset, arrayLength)
          innerOffset += arrayLength * 8
          break
        default: {
          // string arrau or nested struct array. Read each element individually and push onto an
          // array
          const array = []
          const fieldOutput = {}
          for (let i = 0; i < arrayLength; i++) {
            const curOffset = offset + innerOffset
            innerOffset += readNonArrayField(
              schemaMap,
              hashMap,
              field,
              view,
              curOffset,
              fieldOutput,
            )
            array.push(fieldOutput[field.name])
          }
          output[field.name] = array
          break
        }
      }
    } else {
      innerOffset += readNonArrayField(
        schemaMap,
        hashMap,
        field,
        view,
        offset + innerOffset,
        output,
      )
    }
  }

  return innerOffset
}

function typedArray(TypedArrayConstructor, buffer, offset, length) {
  // new TypedArrayConstructor(...) will throw if you try to make a typed array on unaligned boundary
  // but for aligned access we can use a typed array and avoid any extra memory alloc/copy
  if (offset % TypedArrayConstructor.BYTES_PER_ELEMENT === 0) {
    return new TypedArrayConstructor(buffer, offset, length)
  }

  // Copy the data to align it
  // Using _set_ is slightly faster than slice on the array buffer according to benchmarks when written
  const size = TypedArrayConstructor.BYTES_PER_ELEMENT * length
  const copy = new Uint8Array(size)
  copy.set(new Uint8Array(buffer, offset, size))
  return new TypedArrayConstructor(copy.buffer, copy.byteOffset, length)
}

/**
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {MessageDefinitionField} field
 * @param {DataView} view
 * @param {number} offset
 * @param {Record<string, unknown>} output
 * @returns {number}
 */
function readNonArrayField(schemaMap, hashMap, field, view, offset, output) {
  let innerOffset = 0

  if (field.isComplex === true) {
    // Look up the nested message definition
    const nestedMsgdef = schemaMap.get(field.type)
    if (!nestedMsgdef) {
      throw new Error(`Nested message type ${field.type} not found in schema map`)
    }

    if (nestedMsgdef.naked === true) {
      // Nested naked struct (no header). Just deserialize the nested message
      const nestedMessage = {}
      innerOffset += deserializeNakedMessage(
        schemaMap,
        hashMap,
        nestedMsgdef,
        view,
        offset + innerOffset,
        nestedMessage,
      )
      output[field.name] = nestedMessage
    } else {
      // Nested non-naked struct. This has a cbuf message header followed by the message data
      const nestedMessage = deserializeMessage(schemaMap, hashMap, view, offset + innerOffset)
      output[field.name] = nestedMessage.message
      innerOffset += nestedMessage.size
    }
  } else {
    // Simple non-array type
    innerOffset += readBasicType(view, offset, output, field)
  }

  return innerOffset
}

/**
 * Read a basic cbuf type from a DataView into an output message object.
 * @param {DataView} view DataView to read from
 * @param {number} offset Byte offset in the DataView to read from
 * @param {Record<string, unknown>} message Output message object to write a new field to
 * @param {MessageDefinitionField} field Message definition for the field
 * @returns {number} The number of bytes consumed from the buffer
 */
function readBasicType(view, offset, message, field) {
  switch (field.type) {
    case "bool":
      message[field.name] = view.getUint8(offset) !== 0
      return 1
    case "int8":
      message[field.name] = view.getInt8(offset)
      return 1
    case "uint8":
      message[field.name] = view.getUint8(offset)
      return 1
    case "int16":
      message[field.name] = view.getInt16(offset, true)
      return 2
    case "uint16":
      message[field.name] = view.getUint16(offset, true)
      return 2
    case "int32":
      message[field.name] = view.getInt32(offset, true)
      return 4
    case "uint32":
      message[field.name] = view.getUint32(offset, true)
      return 4
    case "int64":
      message[field.name] = view.getBigInt64(offset, true)
      return 8
    case "uint64":
      message[field.name] = view.getBigUint64(offset, true)
      return 8
    case "float32":
      message[field.name] = view.getFloat32(offset, true)
      return 4
    case "float64":
      message[field.name] = view.getFloat64(offset, true)
      return 8
    case "string": {
      let curOffset = 0
      let length = field.upperBound
      if (length == undefined) {
        length = view.getUint32(offset, true)
        curOffset += 4
      }
      const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + curOffset, length)
      const str = textDecoder.decode(bytes)
      message[field.name] = str.split("\0").shift()
      return curOffset + length
    }
    default:
      throw new Error(`Unsupported type ${field.type}`)
  }
}

/**
 * Given a schema map and hash map, and a `CbufMessage` object, return the size of the serialized
 * message in bytes, including the CBUF header.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {CbufMessage} message
 * @returns {number} The size of the serialized message in bytes, including the CBUF header
 */
function serializedMessageSize(schemaMap, hashMap, message) {
  if (typeof message.hashValue !== "bigint") {
    throw new Error(`hashValue must be a bigint`)
  }
  if (typeof message.message !== "object") {
    throw new Error(`message must be an object`)
  }

  // Find the message definition by hash value
  const msgdef =
    message.hashValue === METADATA_DEFINITION.hashValue
      ? METADATA_DEFINITION
      : hashMap.get(message.hashValue)
  if (!msgdef) {
    throw new Error(`Unknown message hash value ${message.hashValue} (${message.typeName}})`)
  }

  return HEADER_SIZE + serializedNakedMessageSize(schemaMap, hashMap, msgdef, message.message)
}

/**
 * Given a schema map and hash map, and a plain JavaScript object representing the message payload,
 * return the size of the serialized message in bytes (not including the CBUF header since this is
 * assumed to be a naked message struct).
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {CbufMessageDefinition} msgdef
 * @param {Record<string, unknown>} message
 * @returns {number} The size of the serialized message in bytes
 */
function serializedNakedMessageSize(schemaMap, hashMap, msgdef, message) {
  let size = 0
  for (const field of msgdef.definitions) {
    const value = message[field.name]

    if (field.isArray === true) {
      // Array field (fixed or variable length)
      let arrayLength = field.arrayLength
      if (arrayLength == undefined) {
        arrayLength = Array.isArray(value) ? value.length : 0
        size += 4
      }

      switch (field.type) {
        case "bool":
        case "uint8":
        case "int8":
          size += arrayLength
          break
        case "uint16":
        case "int16":
          size += arrayLength * 2
          break
        case "uint32":
        case "int32":
        case "float32":
          size += arrayLength * 4
          break
        case "uint64":
        case "int64":
        case "float64":
          size += arrayLength * 8
          break
        default:
          // string array or nested struct array. Read each element individually and push onto an
          // array
          for (const element of value) {
            size += serializedNakedMessageSize(schemaMap, hashMap, element)
          }
          break
      }
    } else {
      if (field.isComplex === true) {
        // Look up the nested message definition
        const nestedMsgdef = schemaMap.get(field.type)
        if (!nestedMsgdef) {
          throw new Error(`Nested message type ${field.type} not found in schema map`)
        }

        if (nestedMsgdef.naked !== true) {
          size += HEADER_SIZE
        }

        size += serializedNakedMessageSize(schemaMap, hashMap, nestedMsgdef, value)
      } else {
        switch (field.type) {
          case "bool":
          case "uint8":
          case "int8":
            size += 1
            break
          case "uint16":
          case "int16":
            size += 2
            break
          case "uint32":
          case "int32":
          case "float32":
            size += 4
            break
          case "uint64":
          case "int64":
          case "float64":
            size += 8
            break
          case "string": {
            let length = field.upperBound
            if (length == undefined) {
              length = typeof value === "string" ? value.length : 0
              size += 4
            }
            size += length
            break
          }
          default:
            throw new Error(`Unsupported type ${field.type}`)
        }
      }
    }
  }

  return size
}

/**
 * Given a schema map and hash map, and a `CbufMessage` object, serialize the message into a byte
 * buffer.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap A map of fully qualified message names to
 *   message definitions obtained from `parseCBufSchema()`.
 * @param {Map<bigint, CbufMessageDefinition>} hashMap A map of hash values to message definitions
 *   obtained from `schemaMapToHashMap()`.
 * @param {CbufMessage} message The message to serialize.
 * @returns {ArrayBuffer} A byte buffer containing the serialized message.
 */
function serializeMessage(schemaMap, hashMap, message) {
  let curOffset = 0

  // Find the message definition by hash value
  const msgdef =
    message.hashValue === METADATA_DEFINITION.hashValue
      ? METADATA_DEFINITION
      : hashMap.get(message.hashValue)
  if (!msgdef) {
    throw new Error(`Unknown message hash value ${message.hashValue} (${message.typeName}})`)
  }

  // Determine the total message size
  const size = serializedMessageSize(schemaMap, hashMap, message)
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)

  // CBuf layout for a non-naked struct:
  //   CBUF_MAGIC (4 bytes) 0x56444e54
  //   size uint32_t (4 bytes)
  //   hashValue uint64_t (8 bytes)
  //   timestamp double (8 bytes)
  //   message data

  // CBUF_MAGIC
  view.setUint32(curOffset, 0x56444e54, true)
  curOffset += 4

  // size and variant
  const hasVariant = message.variant != undefined
  const sizeAndVariant = (hasVariant ? message.variant << 27 : 0) | size
  view.setUint32(curOffset, sizeAndVariant, true)
  curOffset += 4

  // hashValue
  view.setBigUint64(curOffset, message.hashValue, true)
  curOffset += 8

  // timestamp
  view.setFloat64(curOffset, message.timestamp, true)
  curOffset += 8

  // message data
  curOffset += serializeNakedMessage(schemaMap, hashMap, msgdef, message.message, view, curOffset)

  return buffer
}

/**
 * Serialize a single naked struct message into the given DataView at the given offset.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {CbufMessageDefinition} msgdef The message definition for the message to serialize
 * @param {Record<string, unknown>} message The message payload to serialize
 * @param {DataView} view The DataView to write to
 * @param {number} offset The byte offset into the DataView to write to
 * @returns {number} The number of bytes written to the DataView
 */
function serializeNakedMessage(schemaMap, hashMap, msgdef, message, view, offset) {
  let innerOffset = 0
  for (const field of msgdef.definitions) {
    const value = message[field.name]

    if (field.isArray === true) {
      // Array field (fixed or variable length)
      let arrayLength = field.arrayLength
      if (arrayLength == undefined) {
        arrayLength = Array.isArray(value) ? value.length : 0
        view.setUint32(offset + innerOffset, arrayLength, true)
        innerOffset += 4
      }

      for (let i = 0; i < arrayLength; i++) {
        innerOffset += serializeNonArrayField(
          schemaMap,
          hashMap,
          field,
          value[i],
          view,
          offset + innerOffset,
        )
      }
    } else {
      innerOffset += serializeNonArrayField(
        schemaMap,
        hashMap,
        field,
        value,
        view,
        offset + innerOffset,
      )
    }
  }

  return innerOffset
}

/**
 * Serialize a single non-array field into the given DataView at the given offset.
 *
 * @param {Map<string, CbufMessageDefinition>} schemaMap
 * @param {Map<bigint, CbufMessageDefinition>} hashMap
 * @param {MessageDefinitionField} field
 * @param {unknown} value
 * @param {DataView} view
 * @param {number} curOffset
 * @returns {number}
 */
function serializeNonArrayField(schemaMap, hashMap, field, value, view, curOffset) {
  let innerOffset = 0

  if (field.isComplex === true) {
    // Look up the nested message definition
    const nestedMsgdef = schemaMap.get(field.type)
    if (!nestedMsgdef) {
      throw new Error(`Nested message type ${field.type} not found in schema map`)
    }

    if (nestedMsgdef.naked !== true) {
      const nestedSize = serializedNakedMessageSize(schemaMap, hashMap, nestedMsgdef, value)

      view.setUint32(curOffset + innerOffset, 0x56444e54, true)
      innerOffset += 4
      view.setUint32(curOffset + innerOffset, HEADER_SIZE + nestedSize, true)
      innerOffset += 4
      view.setBigUint64(curOffset + innerOffset, nestedMsgdef.hashValue, true)
      innerOffset += 8
      view.setFloat64(curOffset + innerOffset, 0.0, true)
      innerOffset += 8
    }

    innerOffset += serializeNakedMessage(schemaMap, hashMap, nestedMsgdef, value, view, curOffset)
  } else {
    switch (field.type) {
      case "bool":
      case "uint8":
        view.setUint8(curOffset + innerOffset, value)
        innerOffset += 1
        break
      case "int8":
        view.setInt8(curOffset + innerOffset, value)
        innerOffset += 1
        break
      case "uint16":
        view.setUint16(curOffset + innerOffset, value, true)
        innerOffset += 2
        break
      case "int16":
        view.setInt16(curOffset + innerOffset, value, true)
        innerOffset += 2
        break
      case "uint32":
        view.setUint32(curOffset + innerOffset, value, true)
        innerOffset += 4
        break
      case "int32":
        view.setInt32(curOffset + innerOffset, value, true)
        innerOffset += 4
        break
      case "float32":
        view.setFloat32(curOffset + innerOffset, value, true)
        innerOffset += 4
        break
      case "uint64":
        view.setBigUint64(curOffset + innerOffset, value, true)
        innerOffset += 8
        break
      case "int64":
        view.setBigInt64(curOffset + innerOffset, value, true)
        innerOffset += 8
        break
      case "float64":
        view.setFloat64(curOffset + innerOffset, value, true)
        innerOffset += 8
        break
      case "string": {
        let length = field.upperBound
        if (length == undefined) {
          length = typeof value === "string" ? value.length : 0
          view.setUint32(curOffset + innerOffset, length, true)
          innerOffset += 4
        }
        if (value) {
          const bytes = textEncoder.encode(value)
          const byteOffset = view.byteOffset + curOffset + innerOffset
          new Uint8Array(view.buffer, byteOffset, length).set(bytes)
        }
        innerOffset += length
        break
      }
      default:
        throw new Error(`Unsupported type ${field.type}`)
    }
  }

  return innerOffset
}

module.exports.parseCBufSchema = parseCBufSchema
module.exports.schemaMapToHashMap = schemaMapToHashMap
module.exports.deserializeMessage = deserializeMessage
module.exports.serializeMessage = serializeMessage
module.exports.serializedMessageSize = serializedMessageSize

/**
 * A promise a consumer can listen to, to wait for the module to finish loading.
 * module loading is async and can take several hundred milliseconds. Accessing
 * the module before it is loaded will throw an error.
 * @type {Promise<void>}
 */
module.exports.isLoaded = ModulePromise.then((mod) => mod["ready"].then(() => {}))

// Wait for the promise returned from ModuleFactory to resolve
ModulePromise.then((mod) => {
  Module = mod

  // export the Module object for testing purposes _only_
  if (typeof process === "object" && process.env.NODE_ENV === "test") {
    // eslint-disable-next-line no-underscore-dangle
    module.exports.__module = Module
  }
})
