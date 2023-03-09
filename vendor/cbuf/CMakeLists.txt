cmake_minimum_required(VERSION 3.13.0)

project(cbuf)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (${CMAKE_CXX_COMPILER_ID} STREQUAL "GNU")
  #  GCC specific flags
  set(CMAKE_CXX_FLAGS
          "${CMAKE_CXX_FLAGS} \
    -pedantic \
    -Werror \
    -Wall \
    -Wextra \
    -Wno-sign-conversion \
    -Wno-sign-compare \
    -Wno-format \
    -Wno-format-zero-length \
    -Wno-stringop-truncation \
    -Wno-unused-parameter \
    -Wno-maybe-uninitialized \
    ")
else()
  set(CMAKE_CXX_FLAGS
          "${CMAKE_CXX_FLAGS} \
    -Werror \
    -Wall \
    -Wextra \
    -Weverything \
    -Werror=return-type \
    -Wno-c++98-compat \
    -Wno-c++98-compat-pedantic \
    -Wno-ctad-maybe-unsupported \
    -Wno-global-constructors \
    -Wno-exit-time-destructors \
    -Wno-double-promotion \
    -Wno-gnu-zero-variadic-macro-arguments")

  set(CMAKE_CXX_FLAGS
          "${CMAKE_CXX_FLAGS} \
    -Wno-unused-parameter \
    -Wno-weak-vtables \
    -Wno-old-style-cast \
    -Wno-padded \
    -Wno-missing-prototypes \
    -Wno-shadow \
    -Wno-sign-conversion \
    -Wno-missing-variable-declarations \
    -Wno-missing-noreturn \
    -Wno-switch-enum \
    -Wno-unreachable-code \
    -Wno-shorten-64-to-32 \
    -Wno-zero-as-null-pointer-constant \
    -Wno-sign-compare \
    -Wno-cast-align \
    -Wno-packed \
    -Wno-implicit-int-conversion \
    -Wno-float-equal \
    -Wno-covered-switch-default \
    -Wno-unused-macros \
    -Wno-ignored-qualifiers \
    -Wno-cast-qual \
    -Wno-disabled-macro-expansion \
    -Wno-unreachable-code-return \
    -Wno-zero-as-null-pointer-constant \
    -Wno-deprecated-declarations \
    -Wno-format \
    -Wno-unused-but-set-variable")
endif()

set(CBUF_PARSE_SRCS
    src/AstPrinter.cpp src/CPrinter.cpp src/FileData.cpp src/Lexer.cpp src/Parser.cpp src/Allocator.cpp
    src/StringBuffer.cpp src/SymbolTable.cpp src/TextType.cpp src/Token.cpp src/CBufParser.cpp src/Interp.cpp
    src/StdStringBuffer.cpp)

set(CBUF_HDRS include/cbuf_preamble.h include/vstring.h include/CBufParser.h)

set(CBUF_SRCS src/cbuf.cpp)

add_library(cbuf_parse STATIC ${CBUF_PARSE_SRCS} ${CBUF_HDRS})
target_include_directories(cbuf_parse PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
