process.env.NODE_ENV = "test"

const assert = require("assert")
const Cbuf = require("../")

describe("parsing", () => {
  it("waits until module is ready", (done) => {
    Cbuf.isLoaded.then(done)
  })

  it("parses all cbuf schema features", async () => {
    await Cbuf.isLoaded

    const result = Cbuf.parseCBufSchema(`
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
`)
    console.dir(result, { depth: 10 })
  })
})
