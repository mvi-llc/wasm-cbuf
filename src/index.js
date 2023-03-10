const ModuleFactory = require("./wasm-cbuf")
const ModulePromise = ModuleFactory()

let Module

const METADATA_DEFINITION = {
  name: "cbufmsg::metadata",
  hashValue: 13719997278438781638n,
  line: 6,
  column: 5,
  naked: false,
  simple: false,
  hasCompact: false,
  definitions: [
    { name: "msg_hash", type: "uint64" },
    { name: "msg_name", type: "string" },
    { name: "msg_meta", type: "string" },
  ],
}

const textDecoder = new TextDecoder()

function ensureLoaded() {
  if (!Module) {
    throw new Error(`wasm-cbuf has not finished loading. Please wait with "await Cbuf.isLoaded"`)
  }
}

/**
 * Parse a CBuf `.cbuf` schema into an object containing an error string or a
 * `Map<string, MessageDefinition>`.
 *
 * @param {string} schemaText The schema text to parse. This is the contents of a `.cbuf` file where
 *   all #include statements have been expanded.
 * @returns { { error?: string; schema: Map<string, import("@foxglove/message-definition").MessageDefinition> } }
 *   An object containing the parsed schema as a Map<string, MessageDefinition> mapping fully
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
 * Takes a parsed schema (`Map<string, MessageDefinition>`) which maps message names to message
 * definitions and returns a new `Map<BigInt, MessageDefinition>` mapping hash values to message
 * definitions.
 *
 * @param {Map<string, import("@foxglove/message-definition").MessageDefinition>} schemaMap
 * @returns {Map<BigInt, import("@foxglove/message-definition").MessageDefinition>} Mapping from
 *   hash values to message definitions.
 */
function schemaMapToHashMap(schemaMap) {
  const hashMap = new Map()
  for (const definition of schemaMap.values()) {
    hashMap.set(definition.hashValue, definition)
  }
  return hashMap
}

/**
 * Given a schema hash map (`Map<BigInt, MessageDefinition>`), a byte buffer, and optional offset
 * into the buffer, deserialize the buffer into a JavaScript object representing a single message.
 *
 * @param { Map<string, import("@foxglove/message-definition").MessageDefinition> } hashMap A
 *   map of hash values to message definitions obtained from `parseCBufSchema()` then
 *   `schemaMapToHashMap()`.
 * @param {Uint8Array} data The byte buffer to deserialize from.
 * @param {number | undefined} offset Optional byte offset into the buffer to deserialize from.
 * @returns {Record<string, unknown>} A JavaScript object representing the deserialized message.
 */
function deserializeMessage(hashMap, data, offset) {
  ensureLoaded()

  offset = offset || 0
  if (offset < 0 || offset >= data.length) {
    throw new Error(`Invalid offset ${offset} for buffer of length ${data.length}`)
  }

  // CBuf layout for a non-naked struct:
  //   CBUF_MAGIC (4 bytes) 0x56444e54
  //   size uint32_t (4 bytes)
  //   hash uint64_t (8 bytes)
  //   timestamp double (8 bytes)
  //   message data

  const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset)
  if (view.byteLength < 24) {
    throw new Error(`Buffer too small to contain cbuf header: ${view.byteLength} bytes`)
  }

  offset = 0
  const magic = view.getUint32(offset, true)
  offset += 4

  if (magic !== 0x56444e54) {
    throw new Error(`Invalid cbuf magic 0x${magic.toString(16)}`)
  }

  const size = view.getUint32(offset, true)
  offset += 4
  if (size > view.byteLength) {
    throw new Error(`cbuf size ${size} exceeds buffer of length ${view.byteLength}`)
  }

  const hashValue = view.getBigUint64(offset, true)
  offset += 8

  let msgdef = hashMap.get(hashValue)
  if (!msgdef && hashValue === METADATA_DEFINITION.hashValue) {
    msgdef = METADATA_DEFINITION
  }
  if (!msgdef) {
    throw new Error(`cbuf hash value ${hashValue} not found in the hash map`)
  }

  const timestamp = view.getFloat64(offset, true)
  offset += 8

  const message = {}
  offset += deserializeNakedMessage(hashMap, msgdef, view, offset, message)

  if (offset !== size) {
    throw new Error(`cbuf size ${size} does not match decoded size ${offset}`)
  }

  return { typeName: msgdef.name, size, hashValue, timestamp, message }
}

function deserializeNakedMessage(hashMap, msgdef, view, offset, output) {
  let innerOffset = 0

  for (const field of msgdef.definitions) {
    if (field.isArray === true) {
      // FIXME
      throw new Error("Array fields are not yet supported")
    } else if (field.isComplex === true) {
      if (field.naked === true) {
        // Nested naked struct (no header). Look up the definition by hash value
        const nestedMsgdef = hashMap.get(field.hashValue)
        if (!nestedMsgdef) {
          throw new Error(
            `Nested message type ${field.type} (${field.hashValue}) not found in hash map`,
          )
        }

        // Deserialize the nested message
        const nestedMessage = {}
        innerOffset += deserializeNakedMessage(
          hashMap,
          nestedMsgdef,
          view,
          offset + innerOffset,
          nestedMessage,
        )
        output[field.name] = nestedMessage
      } else {
        output[field.name] = deserializeMessage(hashMap, view.buffer, offset + innerOffset)
      }
    } else {
      // Simple non-array type
      innerOffset += readBasicType(view, offset + innerOffset, output, field)
    }
  }

  return innerOffset
}

function readBasicType(view, offset, message, definition) {
  switch (definition.type) {
    case "bool":
      message[definition.name] = view.getUint8(offset) !== 0
      return 1
    case "int8":
      message[definition.name] = view.getInt8(offset)
      return 1
    case "uint8":
      message[definition.name] = view.getUint8(offset)
      return 1
    case "int16":
      message[definition.name] = view.getInt16(offset, true)
      return 2
    case "uint16":
      message[definition.name] = view.getUint16(offset, true)
      return 2
    case "int32":
      message[definition.name] = view.getInt32(offset, true)
      return 4
    case "uint32":
      message[definition.name] = view.getUint32(offset, true)
      return 4
    case "int64":
      message[definition.name] = view.getBigInt64(offset, true)
      return 8
    case "uint64":
      message[definition.name] = view.getBigUint64(offset, true)
      return 8
    case "float32":
      message[definition.name] = view.getFloat32(offset, true)
      return 4
    case "float64":
      message[definition.name] = view.getFloat64(offset, true)
      return 8
    case "string": {
      const length = view.getUint32(offset, true)
      offset += 4
      const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length)
      message[definition.name] = textDecoder.decode(bytes)
      return 4 + length
    }
    default:
      throw new Error(`Unsupported type ${definition.type}`)
  }
}

module.exports.parseCBufSchema = parseCBufSchema
module.exports.schemaMapToHashMap = schemaMapToHashMap
module.exports.deserializeMessage = deserializeMessage

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
    module.exports.__module = Module
  }
})
