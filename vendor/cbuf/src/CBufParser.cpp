#include "CBufParser.h"

#include <cmath>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
// Vector is here only for conversions
#include <vector>

#include "Interp.h"
#include "Parser.h"
#include "SymbolTable.h"
#include "cbuf_preamble.h"

static bool computeSizes(ast_struct* st, SymbolTable* symtable, Interp* interp);

// Compute basic element type size, does not take into account arrays
static bool computeElementTypeSize(ast_element* elem, SymbolTable* symtable, Interp* interp,
                                   u32& csize) {
  switch (elem->type) {
    case TYPE_BOOL:
    case TYPE_U8:
    case TYPE_S8:
      csize = 1;
      break;
    case TYPE_U16:
    case TYPE_S16:
      csize = 2;
      break;
    case TYPE_F32:
    case TYPE_U32:
    case TYPE_S32:
      csize = 4;
      break;
    case TYPE_F64:
    case TYPE_U64:
    case TYPE_S64:
      csize = 8;
      break;
    case TYPE_STRING:
      csize = (u32)sizeof(std::string);
      break;
    case TYPE_SHORT_STRING:
      // Short string is always 16 chars
      csize = 16;
      break;
    case TYPE_CUSTOM: {
      if (symtable->find_enum(elem) != nullptr) {
        csize = 4;
      } else {
        auto* inner_st = symtable->find_struct(elem);
        if (!inner_st) {
          if (interp) {
            interp->Error("Could not find struct %s\n", elem->name);
          }
          return false;
        }
        bool bret = computeSizes(inner_st, symtable, interp);
        if (!bret) return false;
        csize = inner_st->csize;
      }
      break;
    }
    default:
      if (interp) {
        interp->Error("Unknown type %d\n", elem->type);
      }
      return false;
  }
  return true;
}

// This function assumes packed structs. If packing is left to default,
// this would be not right
static bool computeSizes(ast_struct* st, SymbolTable* symtable, Interp* interp) {
  if (st->csize > 0) return true;
  if (!st->naked) {
    // All structs have the preamble if not naked
    st->csize = sizeof(cbuf_preamble);
  }

  for (auto* elem : st->elements) {
    u32 csize;
    if (!computeElementTypeSize(elem, symtable, interp, csize)) {
      return false;
    }
    if (elem->array_suffix) {
      // Do not try to support multi dimensional arrays!
      if (elem->array_suffix->next != nullptr) {
        if (interp) {
          interp->Error("Found a non supported multidimensional array at elem %s\n", elem->name);
        }
        return false;
      }
      // if it is an array, dynamic arrays are std::vector
      if (elem->is_dynamic_array) {
        elem->csize = sizeof(std::vector<size_t>);
        elem->typesize = 0;
      } else {
        u32 num_elem_size = elem->is_compact_array ? 4 : 0;  // for the num_elements
        elem->csize = num_elem_size + elem->array_suffix->size * csize;
        elem->typesize = csize;
      }
    } else {
      elem->csize = csize;
      elem->typesize = csize;
    }
    elem->coffset = st->csize;
    st->csize += elem->csize;
  }
  return true;
}

template <class T>
std::string to_string(T val) {
  return std::to_string(val);
}

template <>
std::string to_string(float val) {
  if (std::isnan(val)) {
    return "NaN";
  }
  return std::to_string(val);
}

template <>
std::string to_string(double val) {
  if (std::isnan(val)) {
    return "NaN";
  }
  return std::to_string(val);
}

void insert_with_quotes(std::string& str, const char* s, size_t size) {
  for (size_t i = 0; i < size; i++) {
    if (s[i] == 0) return;
    if (s[i] == '"' || s[i] == '\'') {
      str += '\\';
    }
    str += s[i];
  }
}

static bool processArraySize(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                             u32& array_size) {
  array_size = 1;
  if (elem->array_suffix) {
    if (elem->is_dynamic_array || elem->is_compact_array) {
      // This is a dynamic array
      array_size = *(u32*)bin_buffer;
      bin_buffer += sizeof(array_size);
      buf_size -= sizeof(array_size);
    } else {
      // this is a static array
      array_size = elem->array_suffix->size;
    }
    if (elem->is_compact_array && array_size > elem->array_suffix->size) {
      return false;
    }
  }
  return true;
}

template <class T>
void print(T elem) {
  printf("%d", elem);
}

template <>
void print<u32>(u32 elem) {
  printf("%u", elem);
}

template <>
void print<u64>(u64 elem) {
  printf("%" PRIu64, elem);
}

template <>
void print<s64>(s64 elem) {
  printf("%" PRId64, elem);
}

template <>
void print<f64>(f64 elem) {
  printf("%.18f", elem);

  // Use this if you want the binary double
  // printf("0x%" PRIx64, *(u64 *)(double *)&elem);
}

template <>
void print<f32>(f32 elem) {
  printf("%.10f", elem);
}

template <class T>
bool process_element_jstr(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                          std::string& jstr) {
  T val;
  u32 array_size;
  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }

  if (elem->array_suffix) {
    jstr += "\"";
    jstr += elem->name;
    jstr += "\":[";

    assert(elem->type != TYPE_CUSTOM);
    for (int i = 0; i < array_size; i++) {
      val = *(T*)bin_buffer;
      bin_buffer += sizeof(val);
      buf_size -= sizeof(val);
      if (i > 0) {
        jstr += ",";
      }
      jstr += ::to_string(val);
    }
    jstr += "]";
  } else {
    // This is a single element, not an array
    val = *(T*)bin_buffer;
    bin_buffer += sizeof(val);
    buf_size -= sizeof(val);
    jstr += "\"";
    jstr += elem->name;
    jstr += "\":";
    jstr += ::to_string(val);
  }
  return true;
}

bool process_element_string_jstr(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                 std::string& jstr) {
  u32 array_size;
  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }

  if (elem->array_suffix) {
    jstr += "\"";
    jstr += elem->name;
    jstr += "\":[";

    for (int i = 0; i < array_size; i++) {
      u32 str_size;
      // This is a dynamic array
      str_size = *(u32*)bin_buffer;
      bin_buffer += sizeof(str_size);
      buf_size -= sizeof(str_size);
      if (i > 0) {
        jstr += ",";
      }
      jstr += "\"";
      insert_with_quotes(jstr, (char*)bin_buffer, str_size);
      jstr += "\"";

      bin_buffer += str_size;
      buf_size -= str_size;
    }
    jstr += "]";
    return true;
  }

  jstr += "\"";
  jstr += elem->name;
  jstr += "\":\"";

  // This is a string
  u32 str_size;
  // This is a dynamic array
  str_size = *(u32*)bin_buffer;
  bin_buffer += sizeof(str_size);
  buf_size -= sizeof(str_size);
  insert_with_quotes(jstr, (char*)bin_buffer, str_size);
  jstr += "\"";
  bin_buffer += str_size;
  buf_size -= str_size;
  return true;
}

bool process_element_short_string_jstr(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                       std::string& jstr) {
  char str[16];
  u32 array_size;
  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }
  if (elem->array_suffix) {
    jstr += "\"";
    jstr += elem->name;
    jstr += "\":[";

    for (int i = 0; i < array_size; i++) {
      u32 str_size = 16;
      if (i > 0) {
        jstr += ",";
      }
      jstr += "\"";
      memcpy(str, bin_buffer, str_size);
      jstr += str;
      jstr += "\"";

      bin_buffer += str_size;
      buf_size -= str_size;
    }
    jstr += "]";
    return true;
  }

  jstr += "\"";
  jstr += elem->name;
  jstr += "\":\"";

  // This is a static string
  u32 str_size = 16;
  memcpy(str, bin_buffer, str_size);
  jstr += str;
  jstr += "\"";
  bin_buffer += str_size;
  buf_size -= str_size;
  return true;
}

template <class T>
bool process_element(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                     const std::string& prefix) {
  T val;
  if (elem->array_suffix) {
    // This is an array
    u32 array_size;
    if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
      return false;
    }
    if (array_size > 1000) {
      printf("%s%s[%d] = ...\n", prefix.c_str(), elem->name, array_size);
      bin_buffer += sizeof(val) * array_size;
      buf_size -= sizeof(val) * array_size;
    } else {
      if (elem->is_dynamic_array || elem->is_compact_array)
        printf("%snum_%s = %d\n", prefix.c_str(), elem->name, array_size);
      printf("%s%s[%d] = ", prefix.c_str(), elem->name, array_size);
      for (int i = 0; i < array_size; i++) {
        val = *(T*)bin_buffer;
        bin_buffer += sizeof(val);
        buf_size -= sizeof(val);
        print(val);
        if (i < array_size - 1) printf(", ");
      }
      printf("\n");
    }
  } else {
    // This is a single element, not an array
    val = *(T*)bin_buffer;
    bin_buffer += sizeof(val);
    buf_size -= sizeof(val);
    printf("%s%s: ", prefix.c_str(), elem->name);
    print(val);
    printf("\n");
  }
  return true;
}

template <class T>
bool skip_element(u8*& bin_buffer, size_t& buf_size, u32 array_size) {
  bin_buffer += sizeof(T) * array_size;
  buf_size -= sizeof(T) * array_size;
  return true;
}

bool skip_string(u8*& bin_buffer, size_t& buf_size, u32 array_size) {
  for (u32 i = 0; i < array_size; i++) {
    // Read the size of the string
    u32 str_size = *(u32*)bin_buffer;
    bin_buffer += sizeof(u32);
    buf_size -= sizeof(u32);
    // Read the characters
    bin_buffer += str_size;
    buf_size -= str_size;
  }
  return true;
}

bool skip_short_string(u8*& bin_buffer, size_t& buf_size, u32 array_size) {
  bin_buffer += sizeof(char) * 16 * array_size;
  buf_size -= sizeof(char) * 16 * array_size;
  return true;
}

template <class SrcType, class DstType>
void convert_element(SrcType val, ast_element* dst_elem, u8* dst_buf) {
  if (dst_elem->array_suffix && dst_elem->is_dynamic_array) {
    std::vector<DstType>& v = *(std::vector<DstType>*)dst_buf;
    v.push_back((DstType)val);
  } else {
    *(DstType*)dst_buf = (DstType)val;
  }
}

template <class T>
bool process_element_conversion(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                CBufParser& dst_parser, ast_element* dst_elem, u8* dst_buf,
                                u32 dst_size) {
  T val;
  u32 array_size = 1;  // for those cases without an array
  if ((elem->array_suffix != nullptr) ^ (dst_elem->array_suffix != nullptr)) {
    // We do not support conversions from non array to array or viceversa
    return false;
  }

  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }

  u32 dst_array_size = 0;
  bool check_dst_array = false;
  u8* dst_elem_buf = dst_buf;
  u32 dst_elem_size = dst_size;

  if (dst_elem->array_suffix) {
    if (dst_elem->is_compact_array) {
      // For compact arrays, write the num
      *(u32*)dst_elem_buf = array_size;
      dst_elem_buf += sizeof(array_size);
      dst_elem_size -= sizeof(array_size);
    }
    if (!dst_elem->is_dynamic_array) {
      check_dst_array = true;
      dst_array_size = dst_elem->array_suffix->size;
    }
  }

  for (int i = 0; i < array_size; i++) {
    // Handle the case where the dest array is compact/fixed and smaller than the source
    if (check_dst_array && i >= dst_array_size) {
      return skip_element<T>(bin_buffer, buf_size, array_size - i);
    }
    val = *(T*)bin_buffer;
    bin_buffer += sizeof(val);
    buf_size -= sizeof(val);

    // Now figure out how to stuff val into the dst_st, their elem
    switch (dst_elem->type) {
      case TYPE_U8: {
        convert_element<T, u8>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_U16: {
        convert_element<T, u16>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_U32: {
        convert_element<T, u32>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_U64: {
        convert_element<T, u64>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_S8: {
        convert_element<T, s8>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_S16: {
        convert_element<T, s16>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_S32: {
        convert_element<T, s32>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_S64: {
        convert_element<T, s64>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_F32: {
        convert_element<T, f32>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_F64: {
        convert_element<T, f64>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_BOOL: {
        convert_element<T, bool>(val, dst_elem, dst_elem_buf);
        break;
      }
      case TYPE_STRING: {
        // We do not support converting from a number to string
        return false;
      }
      case TYPE_SHORT_STRING: {
        // We do not support converting from a number to string
        return false;
      }
      case TYPE_CUSTOM: {
        if (dst_parser.isEnum(dst_elem)) {
          convert_element<T, u32>(val, dst_elem, dst_elem_buf);
        } else {
          // We cannot convert from number to struct
          return false;
        }
        break;
      }
      default:
        return false;
    }
    dst_elem_buf += dst_elem->typesize;
    dst_elem_size -= dst_elem->typesize;
  }

  return true;
}

template <class T>
bool process_element_csv(const ast_element* elem, u8*& bin_buffer, size_t& buf_size, bool doprint) {
  T val;
  if (elem->array_suffix) {
    // This is an array
    u32 num_elements;
    u32 array_size = elem->array_suffix->size;
    if (elem->is_dynamic_array || elem->is_compact_array) {
      // This is a dynamic array
      num_elements = *reinterpret_cast<u32*>(bin_buffer);
      bin_buffer += sizeof(num_elements);
      buf_size -= sizeof(num_elements);
    } else {
      // this is a static array
      num_elements = array_size;
    }
    if (elem->is_compact_array && array_size > elem->array_suffix->size) {
      return false;
    }

    for (int i = 0; i < array_size; i++) {
      if (i < num_elements) {
        val = *reinterpret_cast<T*>(bin_buffer);
        bin_buffer += sizeof(val);
        buf_size -= sizeof(val);
        if (doprint) {
          print(val);
        }
      }
      if (doprint && i < array_size - 1) {
        printf(",");
      }
    }
  } else {
    // This is a single element, not an array
    val = *(T*)bin_buffer;
    bin_buffer += sizeof(val);
    buf_size -= sizeof(val);
    if (doprint) print(val);
  }
  return true;
}

bool process_element_string(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                            const std::string& prefix) {
  char* str;
  if (elem->array_suffix) {
    // This is an array
    u32 array_size;
    if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
      return false;
    }

    for (int i = 0; i < array_size; i++) {
      u32 str_size;
      // This is a dynamic array
      str_size = *(u32*)bin_buffer;
      bin_buffer += sizeof(str_size);
      buf_size -= sizeof(str_size);
      str = (char*)bin_buffer;
      bin_buffer += str_size;
      buf_size -= str_size;

      printf("%s%s[%d] = [ %.*s ]\n", prefix.c_str(), elem->name, i, str_size, str);
    }
    return true;
  }
  // This is an array
  u32 str_size;
  // This is a dynamic array
  str_size = *(u32*)bin_buffer;
  bin_buffer += sizeof(str_size);
  buf_size -= sizeof(str_size);
  str = (char*)bin_buffer;
  bin_buffer += str_size;
  buf_size -= str_size;

  printf("%s%s = [ %.*s ]\n", prefix.c_str(), elem->name, str_size, str);
  return true;
}

bool convert_element_string(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                            CBufParser& dst_parser, ast_element* dst_elem, u8* dst_buf,
                            size_t dst_size) {
  char* str;
  u32 array_size = 1;
  if ((elem->array_suffix != nullptr) ^ (dst_elem->array_suffix != nullptr)) {
    // We do not support conversions from non array to array or viceversa
    return false;
  }
  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }

  u32 dst_array_size = 0;
  bool check_dst_array = false;
  u8* dst_elem_buf = dst_buf;
  u32 dst_elem_size = dst_size;

  if (elem->array_suffix) {
    if (dst_elem->is_compact_array) {
      // For compact arrays, write the num
      *(u32*)dst_elem_buf = array_size;
      dst_elem_buf += sizeof(array_size);
      dst_elem_size -= sizeof(array_size);
    }
    if (!dst_elem->is_dynamic_array) {
      check_dst_array = true;
      dst_array_size = dst_elem->array_suffix->size;
    }
  }

  for (int i = 0; i < array_size; i++) {
    // Handle the case where the dest array is compact/fixed and smaller than the source
    if (check_dst_array && i >= dst_array_size) {
      return skip_string(bin_buffer, buf_size, array_size - i);
    }

    u32 str_size;
    // This is a dynamic array
    str_size = *(u32*)bin_buffer;
    bin_buffer += sizeof(str_size);
    buf_size -= sizeof(str_size);
    str = (char*)bin_buffer;
    bin_buffer += str_size;
    buf_size -= str_size;

    switch (dst_elem->type) {
      case TYPE_STRING: {
        if (dst_elem->array_suffix && dst_elem->is_dynamic_array) {
          std::vector<std::string>& v = *(std::vector<std::string>*)dst_elem_buf;
          v.push_back(std::string{str, str_size});
        } else {
          // Use placement new because the memory in dst_elem_buf might not be correct
          new (dst_elem_buf) std::string{str, str_size};
        }
        break;
      }
      case TYPE_SHORT_STRING: {
        if (dst_elem->array_suffix && dst_elem->is_dynamic_array) {
          std::vector<std::string>& v = *(std::vector<std::string>*)dst_elem_buf;
          v.push_back(std::string{str, str_size});
        } else {
          strncpy((char*)dst_elem_buf, str, 16);
        }
        break;
      }
      default:
        return false;
    }
    dst_elem_buf += dst_elem->typesize;
    dst_elem_size -= dst_elem->typesize;
  }

  return true;
}

bool process_element_string_csv(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                bool doprint) {
  char* str;
  if (elem->array_suffix) {
    assert(false);
    // Array of strings not implemented for csv. What would the header be? what size of array
    // of strings, given that we would have many messages with different sizes?
  }
  // This is an array
  u32 str_size;
  // This is a dynamic array
  str_size = *(u32*)bin_buffer;
  bin_buffer += sizeof(str_size);
  buf_size -= sizeof(str_size);
  str = (char*)bin_buffer;
  bin_buffer += str_size;
  buf_size -= str_size;

  if (doprint) printf("%.*s", str_size, str);
  return true;
}

bool process_element_short_string(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                  const std::string& prefix) {
  if (elem->array_suffix) {
    // This is an array
    u32 array_size;
    if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
      return false;
    }

    for (int i = 0; i < array_size; i++) {
      u32 str_size = 16;
      char str[16];
      memcpy(str, bin_buffer, str_size);
      bin_buffer += str_size;
      buf_size -= str_size;

      printf("%s%s[%d] = [] %s ]\n", prefix.c_str(), elem->name, i, str);
    }
    return true;
  }

  // This is s static array
  u32 str_size = 16;
  char str[16];
  memcpy(str, bin_buffer, str_size);
  bin_buffer += str_size;
  buf_size -= str_size;

  printf("%s%s = [ %s ]\n", prefix.c_str(), elem->name, str);
  return true;
}

bool convert_element_short_string(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                  CBufParser& dst_parser, ast_element* dst_elem, u8* dst_buf,
                                  size_t dst_size) {
  u32 array_size = 1;
  if ((elem->array_suffix != nullptr) ^ (dst_elem->array_suffix != nullptr)) {
    // We do not support conversions from non array to array or viceversa
    return false;
  }
  if (!processArraySize(elem, bin_buffer, buf_size, array_size)) {
    return false;
  }
  u32 dst_array_size = 0;
  bool check_dst_array = false;
  u8* dst_elem_buf = dst_buf;
  u32 dst_elem_size = dst_size;

  if (elem->array_suffix) {
    if (dst_elem->is_compact_array) {
      // For compact arrays, write the num
      *(u32*)dst_elem_buf = array_size;
      dst_elem_buf += sizeof(array_size);
      dst_elem_size -= sizeof(array_size);
    }
    if (!dst_elem->is_dynamic_array) {
      check_dst_array = true;
      dst_array_size = dst_elem->array_suffix->size;
    }
  }

  for (int i = 0; i < array_size; i++) {
    // Handle the case where the dest array is compact/fixed and smaller than the source
    if (check_dst_array && i >= dst_array_size) {
      return skip_short_string(bin_buffer, buf_size, array_size - i);
    }

    u32 str_size = 16;
    char str[16];
    memcpy(str, bin_buffer, str_size);
    bin_buffer += str_size;
    buf_size -= str_size;

    switch (dst_elem->type) {
      case TYPE_STRING: {
        if (dst_elem->array_suffix && dst_elem->is_dynamic_array) {
          std::vector<std::string>& v = *(std::vector<std::string>*)dst_elem_buf;
          v.push_back(std::string{str, str_size});
        } else {
          new (dst_elem_buf) std::string{str, str_size};
        }
        break;
      }
      case TYPE_SHORT_STRING: {
        if (dst_elem->array_suffix && dst_elem->is_dynamic_array) {
          std::vector<std::string>& v = *(std::vector<std::string>*)dst_elem_buf;
          v.push_back(std::string{str, str_size});
        } else {
          strncpy((char*)dst_elem_buf, str, 16);
        }
        break;
      }
      default:
        return false;
    }
    dst_elem_buf += dst_elem->typesize;
    dst_elem_size -= dst_elem->typesize;
  }

  return true;
}

bool process_element_short_string_csv(const ast_element* elem, u8*& bin_buffer, size_t& buf_size,
                                      bool doprint) {
  if (elem->array_suffix) {
    assert(false);
    // Array of strings not implemented
  }

  // This is s static array
  u32 str_size = 16;
  char str[16];
  memcpy(str, bin_buffer, str_size);
  bin_buffer += str_size;
  buf_size -= str_size;

  if (doprint) printf("%s", str);
  return true;
}

template <typename T>
bool loop_all_structs(ast_global* ast, SymbolTable* symtable, Interp* interp, T func) {
  for (auto* sp : ast->spaces) {
    for (auto* st : sp->structs) {
      if (!func(st, symtable, interp)) {
        return false;
      }
    }
  }

  for (auto* st : ast->global_space.structs) {
    if (!func(st, symtable, interp)) {
      return false;
    }
  }

  return true;
}

/**
 * @brief Computes if a struct is simple or not and set the `simple` and `simple_computed` fields.
 * @return true on success, false on error
 */
bool compute_simple(ast_struct* st, SymbolTable* symtable, Interp* interp) {
  if (st->simple_computed) return st->simple;
  st->simple = true;
  for (auto* elem : st->elements) {
    if (elem->type == TYPE_STRING) {
      st->simple = false;
      st->simple_computed = true;
      return true;
    }
    if (elem->is_dynamic_array) {
      // all dynamic arrays are always not simple!
      st->simple = false;
      st->simple_computed = true;
      return true;
    }
    if (elem->type == TYPE_CUSTOM) {
      if (!symtable->find_symbol(elem)) {
        interp->Error(elem,
                      "Struct %s, element %s was referencing type %s and could not be found\n",
                      st->name, elem->name, elem->custom_name);
        return false;
      }
      auto* inner_st = symtable->find_struct(elem);
      if (inner_st == nullptr) {
        // Must be an enum, it is simple
        continue;
      }
      if (!compute_simple(inner_st, symtable, interp)) {
        return false;
      }
      if (!inner_st->simple) {
        st->simple = false;
        st->simple_computed = true;
        return true;
      }
    }
  }
  st->simple_computed = true;
  return true;
}

bool compute_compact(ast_struct* st, SymbolTable* symtable, Interp* interp) {
  if (st->compact_computed) return st->has_compact;
  st->has_compact = false;
  for (auto* elem : st->elements) {
    if (elem->type == TYPE_STRING) {
      continue;
    }
    if (elem->is_compact_array) {
      st->has_compact = true;
      st->compact_computed = true;
      return true;
    }
    if (elem->type == TYPE_CUSTOM) {
      if (!symtable->find_symbol(elem)) {
        interp->Error(elem,
                      "Struct %s, element %s was referencing type %s and could not be found\n",
                      st->name, elem->name, elem->custom_name);
        return false;
      }
      auto* inner_st = symtable->find_struct(elem);
      if (inner_st == nullptr) {
        // Must be an enum, it is simple
        continue;
      }
      if (!compute_compact(inner_st, symtable, interp)) {
        return false;
      }
      if (inner_st->has_compact) {
        st->has_compact = true;
        st->simple_computed = true;
        return true;
      }
    }
  }
  st->compact_computed = true;
  return true;
}

bool compute_sizes(ast_struct* st, SymbolTable* symbtable, Interp* interp) {
  if (!computeSizes(st, symbtable, interp)) {
    interp->Error(st, "Failed to compute struct size for %s\n", st->name);
    return false;
  }
  return true;
}

CBufParser::CBufParser() {
  pool = new PoolAllocator();
}

CBufParser::~CBufParser() {
  if (sym) {
    delete sym;
    sym = nullptr;
  }

  if (pool) {
    delete pool;
    pool = nullptr;
  }
}

bool CBufParser::StructSize(const char* st_name, size_t& size) {
  Interp interp;

  errors.clear();
  auto* st = decompose_and_find(st_name);
  if (!computeSizes(st, sym, &interp)) {
    WriteError("Failed to compute struct size for %s: %s", st_name,
               interp.has_error() ? interp.getErrorString() : "Unknown error");
    return false;
  }
  size = st->csize;
  return true;
}

bool CBufParser::ParseMetadata(const std::string& metadata, const std::string& struct_name) {
  Parser parser;
  Interp interp;

  errors.clear();

  if (metadata.empty()) {
    WriteError("Error, empty metadata for type %s", struct_name.c_str());
    return false;
  }

  parser.interp = &interp;
  ast = parser.ParseBuffer(metadata.c_str(), metadata.size() - 1, pool, nullptr);
  if (ast == nullptr || !parser.success) {
    WriteError("Error during parsing:\n%s", interp.getErrorString());
    return false;
  }

  if (sym) {
    delete sym;
  }
  sym = new SymbolTable;
  bool bret = sym->initialize(ast);
  if (!bret) {
    WriteError("Error during symbol table parsing:\n%s", interp.getErrorString());
    return false;
  }

  if (!loop_all_structs(ast, sym, &interp, compute_sizes) || interp.has_error()) {
    WriteError("Parsing error: %s",
               interp.has_error() ? interp.getErrorString() : "compute_sizes failed");
    return false;
  }

  main_struct_name = struct_name;
  return true;
}

bool CBufParser::PrintInternal(const ast_struct* st, const std::string& prefix) {
  // All structs have a preamble, skip it
  if (!st->naked) {
    u32 sizeof_preamble = sizeof(cbuf_preamble);  // 8 bytes hash, 4 bytes size
    buffer += sizeof_preamble;
    buf_size -= sizeof_preamble;
  }

  for (auto& elem : st->elements) {
    if (!success) return false;
    switch (elem->type) {
      case TYPE_U8: {
        success = process_element<u8>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_U16: {
        success = process_element<u16>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_U32: {
        success = process_element<u32>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_U64: {
        success = process_element<u64>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_S8: {
        success = process_element<s8>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_S16: {
        success = process_element<s16>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_S32: {
        success = process_element<s32>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_S64: {
        success = process_element<s64>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_F32: {
        success = process_element<f32>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_F64: {
        success = process_element<f64>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_BOOL: {
        success = process_element<u8>(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_STRING: {
        success = process_element_string(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_SHORT_STRING: {
        success = process_element_short_string(elem, buffer, buf_size, prefix);
        break;
      }
      case TYPE_CUSTOM: {
        if (elem->array_suffix) {
          // This is an array
          u32 array_size;
          if (elem->is_dynamic_array || elem->is_compact_array) {
            // This is a dynamic array
            array_size = *(u32*)buffer;
            buffer += sizeof(array_size);
            buf_size -= sizeof(array_size);
          } else {
            // this is a static array
            array_size = elem->array_suffix->size;
          }
          if (elem->is_compact_array && array_size > elem->array_suffix->size) {
            success = false;
            return false;
          }
          if (elem->is_compact_array) {
            printf("%snum_%s = %d\n", prefix.c_str(), elem->name, array_size);
          }

          auto* inst = sym->find_struct(elem);
          if (inst != nullptr) {
            for (u32 i = 0; i < array_size; i++) {
              std::string new_prefix = prefix + elem->name + "[" + ::to_string(i) + "].";
              PrintInternal(inst, new_prefix);
              if (!success) return false;
            }
          } else {
            auto* enm = sym->find_enum(elem);
            if (enm == nullptr) {
              WriteError("Enum %s could not be parsed\n", elem->custom_name);
              return false;
            }
            for (u32 i = 0; i < array_size; i++) {
              process_element<u32>(elem, buffer, buf_size, prefix);
            }
          }

        } else {
          // This is a single element, not an array
          auto* inst = sym->find_struct(elem);
          if (inst != nullptr) {
            std::string new_prefix = prefix + elem->name + ".";
            PrintInternal(inst, new_prefix);
          } else {
            auto* enm = sym->find_enum(elem);
            if (enm == nullptr) {
              WriteError("Enum %s could not be parsed\n", elem->custom_name);
              return false;
            }
            process_element<u32>(elem, buffer, buf_size, prefix);
          }
        }

        break;
      }
      default:
        return false;
    }
  }
  return success;
}

bool CBufParser::SkipElementInternal(const ast_element* elem) {
  u32 array_size = 1;
  if (!processArraySize(elem, buffer, buf_size, array_size)) {
    return false;
  }
  switch (elem->type) {
    case TYPE_U8: {
      // We cannot pass dst_buf here, as the order of dst_buf might not be linear, we have to
      // compute it
      success = skip_element<u8>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_U16: {
      success = skip_element<u16>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_U32: {
      success = skip_element<u32>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_U64: {
      success = skip_element<u64>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_S8: {
      success = skip_element<s8>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_S16: {
      success = skip_element<s16>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_S32: {
      success = skip_element<s32>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_S64: {
      success = skip_element<s64>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_F32: {
      success = skip_element<f32>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_F64: {
      success = skip_element<f64>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_BOOL: {
      success = skip_element<bool>(buffer, buf_size, array_size);
      break;
    }
    case TYPE_STRING: {
      success = skip_string(buffer, buf_size, array_size);
      break;
    }
    case TYPE_SHORT_STRING: {
      success = skip_short_string(buffer, buf_size, array_size);
      break;
    }
    case TYPE_CUSTOM: {
      auto* enm = sym->find_enum(elem);
      if (enm != nullptr) {
        success = skip_element<u32>(buffer, buf_size, array_size);
        break;
      }

      auto* inst = sym->find_struct(elem);
      if (inst == nullptr) {
        // Failed to find the struct, inconsistent metadata
        return false;
      }

      for (u32 i = 0; i < array_size; i++) {
        success = SkipStructInternal(inst);
        if (!success) return false;
      }

      break;
    }
    default:
      return false;
  }
  return success;
}

bool CBufParser::SkipStructInternal(const ast_struct* st) {
  // All structs have a preamble, skip it
  if (!st->naked) {
    u32 sizeof_preamble = sizeof(cbuf_preamble);  // 8 bytes hash, 4 bytes size
    buffer += sizeof_preamble;
    buf_size -= sizeof_preamble;
  }

  for (const auto& elem : st->elements) {
    if (!success) return false;
    success = SkipElementInternal(elem);
  }
  return success;
}

void CBufParser::WriteError(const char* __restrict fmt, ...) {
  va_list args;
  va_start(args, fmt);
  char buf[2048];
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-nonliteral"
  vsnprintf(buf, sizeof(buf), fmt, args);
#pragma GCC diagnostic pop
  va_end(args);
  if (!errors.empty()) {
    errors += "\n";
  }
  errors += buf;
}

ast_struct* CBufParser::decompose_and_find(const char* st_name) {
  char namesp[128] = {};
  auto* sep = strchr(st_name, ':');
  if (sep == nullptr) {
    auto tname = CreateTextType(pool, st_name);
    return sym->find_struct(tname);
  }

  for (int i = 0; st_name[i] != ':'; i++) namesp[i] = st_name[i];
  auto tname = CreateTextType(pool, sep + 2);
  return sym->find_struct(tname, namesp);
}

// Returns the number of bytes consumed
unsigned int CBufParser::Print(const char* st_name, unsigned char* buffer, size_t buf_size) {
  this->buffer = buffer;
  this->buf_size = buf_size;
  std::string prefix = std::string(st_name) + ".";
  success = true;
  if (!PrintInternal(decompose_and_find(st_name), prefix)) {
    return 0;
  }
  this->buffer = nullptr;
  return buf_size - this->buf_size;
}

bool CBufParser::isEnum(const ast_element* elem) const {
  return sym->find_enum(elem) != nullptr;
}
