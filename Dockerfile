FROM emscripten/emsdk:3.1.28

# Install clang-format
RUN apt-get update && \
  apt-get install -y clang-format && \
  rm -rf /var/lib/apt/lists/*

# Build the cbuf static library
COPY vendor/cbuf /cbuf
RUN mkdir -p /cbuf/build && \
  cd /cbuf/build && \
  emcmake cmake \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O3 -msimd128" \
  .. && \
  emmake make

WORKDIR /wasm-cbuf
COPY build.sh pre.js /wasm-cbuf/
COPY src /wasm-cbuf/src

CMD [ "./build.sh" ]
