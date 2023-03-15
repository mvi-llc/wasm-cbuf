#pragma once

#include <stddef.h>
#include <string>

struct ast_global;
struct ast_struct;
struct ast_element;

class PoolAllocator;
class SymbolTable;

class CBufParser {
protected:
  ast_global* ast = nullptr;
  unsigned char* buffer = nullptr;
  size_t buf_size = 0;
  PoolAllocator* pool = nullptr;
  SymbolTable* sym = nullptr;
  bool success = true;
  std::string errors;

  bool PrintInternal(const ast_struct* st, const std::string& prefix);

  bool SkipElementInternal(const ast_element* elem);
  bool SkipStructInternal(const ast_struct* st);

  void WriteError(const char* __restrict fmt, ...);

  std::string main_struct_name;

  ast_struct* decompose_and_find(const char* st_name);

public:
  CBufParser();
  ~CBufParser();

  bool ParseMetadata(const std::string& metadata, const std::string& struct_name);
  bool isParsed() const {
    return ast != nullptr;
  }
  bool isEnum(const ast_element* elem) const;
  bool StructSize(const char* st_name, size_t& size);

  // Returns the number of bytes consumed
  unsigned int Print(const char* st_name, unsigned char* buffer, size_t buf_size);
};
