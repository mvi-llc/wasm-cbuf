#!/usr/bin/env bash

mkdir -p dist

emcc \
  /cbuf/build/libcbuf_parse.a -o dist/wasm-cbuf.js src/SchemaParser.cpp src/wasm-cbuf.cpp \
  -O3 `# compile with all optimizations enabled` \
  -msimd128 `# enable SIMD support` \
  -flto `# enable link time optimization` \
  --bind `# enable emscripten function binding` \
  -I /cbuf/include `# add the cbuf include directory` \
  -I /cbuf/src `# add the cbuf src as an include directory as well for access to ast.h` \
  -s WASM=1 `# compile to .wasm instead of asm.js` \
  -s WASM_BIGINT `# enable BigInt support` \
  --pre-js pre.js `# include pre.js at the top of wasm-cbuf.js` \
  -s MODULARIZE=1 `# include module boilerplate for better node/webpack interop` \
  -s NO_EXIT_RUNTIME=1 `# keep the process around after main exits` \
  -s TOTAL_STACK=1048576 `# use a 1MB stack size instead of the default 5MB` \
  -s INITIAL_MEMORY=1114112 `# start with a ~1MB allocation instead of 16MB, we will dynamically grow` \
  -s ALLOW_MEMORY_GROWTH=1  `# need this because we don't know how large decompressed blocks will be` \
  -s NODEJS_CATCH_EXIT=0 `# we don't use exit() and catching exit will catch all exceptions` \
  -s NODEJS_CATCH_REJECTION=0 `# prevent emscripten from adding an unhandledRejection handler` \
  -s "EXPORTED_FUNCTIONS=[]"

cp src/index.* dist/
