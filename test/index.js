process.env.NODE_ENV = "test"

const { readFileSync } = require("fs")
const assert = require("assert")
const Cbuf = require("../")

const serialized = new Uint8Array(readFileSync(`${__dirname}/serialized.cb`))

describe("parsing", () => {
  it("waits until module is ready", (done) => {
    Cbuf.isLoaded.then(done)
  })

  it("parses the metadata.cbuf definition", async () => {
    await Cbuf.isLoaded

    const result = Cbuf.parseCBufSchema(`
namespace cbufmsg
{
    // Metadata used to be able to recreate cbuf messages
    struct metadata
    {
        u64    msg_hash;
        string msg_name;
        string msg_meta;
    }
}    
`)

    assert.equal(result.schema.size, 1)

    const metadata = result.schema.get("cbufmsg::metadata")
    assert.deepStrictEqual(metadata, {
      name: "cbufmsg::metadata",
      hashValue: 13719997278438781638n,
      line: 6,
      column: 5,
      naked: false,
      definitions: [
        { name: "msg_hash", type: "uint64" },
        { name: "msg_name", type: "string" },
        { name: "msg_meta", type: "string" },
      ],
    })
  })

  it("parses all cbuf schema features", async () => {
    await Cbuf.isLoaded

    const schema = `
// This is a single line comment

/*
    You can have multi-line comments too
    /*
        Oh, and also nested comment. Do not worry.
    */
*/

const uint32_t GlobalConst = 0xffffffff;

struct GlobalStruct { u32 x; }

namespace messages {
  enum LocalEnum {
    A = 10,
    B,
  }

  const float LocalConst = 2.0;

  struct LocalStruct @naked {
    u32 x;
  }

  struct test {
    u8 a;
    s8 b;
    u16 c;
    s16 d = -4;
    u32 e;
    s32 f = 3*4*(12*23) + 70/2;
    u64 g = 17;
    s64 h = -17;
    f32 i;
    f64 j = 2.0 * 3.4 / 2.7;
    bool k = true;
    string l = "test";
    short_string m;
    u8 n[4];
    uint16_t o[];
    uint8_t p[4] @compact;
    string q[2];
    GlobalStruct r;
    LocalStruct s;
    LocalEnum u;
  }
}
`

    const result = Cbuf.parseCBufSchema(schema)
    assert.equal(result.error, undefined)
    assert.equal(result.schema.size, 3)

    const globalStruct = result.schema.get("GlobalStruct")
    const localStruct = result.schema.get("messages::LocalStruct")
    const test = result.schema.get("messages::test")

    assert.deepStrictEqual(globalStruct, {
      name: "GlobalStruct",
      hashValue: 10441124924358324479n,
      line: 13,
      column: 21,
      naked: false,
      definitions: [{ name: "x", type: "uint32" }],
    })

    assert.deepStrictEqual(localStruct, {
      name: "messages::LocalStruct",
      hashValue: 13251862435611663173n,
      line: 23,
      column: 22,
      naked: true,
      definitions: [{ name: "x", type: "uint32" }],
    })

    assert.deepStrictEqual(test, {
      name: "messages::test",
      hashValue: 10424965189645813154n,
      line: 27,
      column: 15,
      naked: false,
      definitions: [
        { name: "a", type: "uint8" },
        { name: "b", type: "int8" },
        { name: "c", type: "uint16" },
        { name: "d", type: "int16", defaultValue: -4 },
        { name: "e", type: "uint32" },
        { name: "f", type: "int32", defaultValue: 2076 },
        { name: "g", type: "uint64", defaultValue: 17n },
        { name: "h", type: "int64", defaultValue: -17n },
        { name: "i", type: "float32" },
        { name: "j", type: "float64", defaultValue: 2.518518518518518 },
        { name: "k", type: "bool", defaultValue: true },
        { name: "l", type: "string", defaultValue: "test" },
        { name: "m", type: "string", upperBound: 16 },
        { name: "n", type: "uint8", isArray: true, arrayLength: 4 },
        { name: "o", type: "uint16", isArray: true },
        { name: "p", type: "uint8", isArray: true, arrayUpperBound: 4 },
        { name: "q", type: "string", isArray: true, arrayLength: 2 },
        { name: "r", type: "GlobalStruct", isComplex: true },
        { name: "s", type: "messages::LocalStruct", isComplex: true },
        { name: "u", type: "int32" },
      ],
    })

    // FIXME: This check is failing due to some leftover state or memory
    // corruption in the wasm module
    // Make sure we can parse the schema repeatedly
    const result2 = Cbuf.parseCBufSchema(schema)
    assert.equal(result2.error, undefined)
  })

  it("repeatedly parses a cbuf", async () => {
    await Cbuf.isLoaded

    const schema = `
namespace messages {
  const float X = 1.0;

  struct test {
    s32 f = 3*4*(12*23) + 70/2;
    s32 g = 1;
    s32 h = -1;
    s32 i;
    f32 j = 2.0 * 3.4 / 2.7;
    s32 k;
    s32 m;
    s32 n;
    s32 o[1];
  }
}
`

    for (let i = 0; i < 1000; i++) {
      const result = Cbuf.parseCBufSchema(schema)
      assert.equal(result.error, undefined)
      assert.equal(result.schema.size, 1)
    }
  })
})

describe("deserializeMessage", () => {
  it("reads a self-describing .cb buffer", () => {
    // Cbuf.deserializeMessage does not use the wasm module, so no need to
    // await Cbuf.isLoaded

    let offset = 0
    const result = Cbuf.deserializeMessage(new Map(), serialized, offset)
    offset += result.size

    assert.equal(result.typeName, "cbufmsg::metadata")
    assert.equal(result.size, 419)
    assert.equal(result.hashValue, 13719997278438781638n)
    assert(Math.abs(result.timestamp - 1677005408.4643354) < 0.000001)
    assert.equal(result.message.msg_hash, 16888428354405413574n)
    assert.equal(result.message.msg_name, "messages::strings")

    const result2 = Cbuf.parseCBufSchema(result.message.msg_meta)
    assert.equal(result2.error, undefined)
    const schema = result2.schema

    assert.equal(schema.size, 3)
    assert.notEqual(schema.get("messages::strings"), undefined)
    assert.notEqual(schema.get("messages::logmsg"), undefined)
    assert.notEqual(schema.get("messages::set_loglevel"), undefined)

    const hashMap = Cbuf.schemaMapToHashMap(schema)

    const result3 = Cbuf.deserializeMessage(hashMap, serialized, offset)
    assert.equal(result3.typeName, "messages::strings")
    assert.equal(result3.size, 104)
    assert.equal(result3.message.key, "launcher_config_path")

    offset += result3.size
    const result4 = Cbuf.deserializeMessage(hashMap, serialized, offset)

    assert.equal(result4.typeName, "messages::strings")
    assert.equal(result4.size, 1357)
    assert.equal(result4.message.key, "launcher_config_json")
  })
})
