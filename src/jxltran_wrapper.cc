// WebAssembly entry points of jxltran-js.
//
// The module is a library: it has no main() and never reads or writes the
// INPUT/OUTPUT files itself. The JavaScript side passes a command line - the
// same argv the native tool would see - plus the INPUT bytes and gets the
// OUTPUT bytes back. Files that other flags mention (--set-exif FILE,
// --extract-*, --append-jxl, --set-splines-from) are staged in the module's
// virtual filesystem through the exported FS object.

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "jxltran_api.h"

namespace {

// Diagnostics of this wrapper: failures that never reach the tool's own
// stderr, such as bad arguments or an allocation failure. The tool reports
// its own errors on stderr, which the JavaScript side captures via printErr.
std::string g_last_message;

}  // namespace

extern "C" {

// Runs one command line in memory:
//
//   argv          NULL-terminated command line; argv[0] is the program name
//                 used in messages and in the undo hint.
//   input         INPUT file contents (nullptr only when input_size is 0).
//   out_data      on success, malloc'ed OUTPUT bytes; the read-only runs
//                 (--info, --help, ...) produce none. Free with mv_free().
//   out_size      size of *out_data, 0 when there is none.
//   undo_command  on success, the malloc'ed single-line command that inverts
//                 this run, or NULL when there is nothing to report.
//
// Returns 0 on success and 1 on failure. Everything the tool prints goes to
// stdout/stderr, which the JavaScript side captures. argv and its strings are
// only read during the call.
int mv_jxltran_run(const char** argv, const uint8_t* input, size_t input_size,
                   uint8_t** out_data, size_t* out_size,
                   char** undo_command) {
  g_last_message.clear();
  if (out_data != nullptr) *out_data = nullptr;
  if (out_size != nullptr) *out_size = 0;
  if (undo_command != nullptr) *undo_command = nullptr;

  if (argv == nullptr || argv[0] == nullptr || out_data == nullptr ||
      out_size == nullptr || undo_command == nullptr) {
    g_last_message = "mv_jxltran_run: missing argument";
    return 1;
  }
  if (input == nullptr && input_size != 0) {
    g_last_message = "mv_jxltran_run: input buffer is null";
    return 1;
  }

  int argc = 0;
  while (argv[argc] != nullptr) ++argc;

  std::vector<uint8_t> input_bytes;
  if (input_size != 0) input_bytes.assign(input, input + input_size);

  std::vector<uint8_t> output;
  std::string undo;
  const int status =
      jxltran::RunCommandLine(argc, argv, &input_bytes, &output, &undo);

  // The module never exits, so stdio would keep what the tool printed: hand
  // it to the JavaScript print/printErr handlers right now.
  std::fflush(stdout);
  std::fflush(stderr);

  if (status != 0) return status;

  if (!output.empty()) {
    uint8_t* buffer = static_cast<uint8_t*>(std::malloc(output.size()));
    if (buffer == nullptr) {
      g_last_message = "mv_jxltran_run: out of memory";
      return 1;
    }
    std::memcpy(buffer, output.data(), output.size());
    *out_data = buffer;
    *out_size = output.size();
  }
  if (!undo.empty()) {
    char* buffer = static_cast<char*>(std::malloc(undo.size() + 1));
    if (buffer == nullptr) {
      std::free(*out_data);
      *out_data = nullptr;
      *out_size = 0;
      g_last_message = "mv_jxltran_run: out of memory";
      return 1;
    }
    std::memcpy(buffer, undo.c_str(), undo.size() + 1);
    *undo_command = buffer;
  }
  return 0;
}

// Frees a buffer returned by mv_jxltran_run. NULL is ignored.
void mv_free(void* ptr) { std::free(ptr); }

// Version of the embedded jxltran sources, set by build.sh.
const char* mv_version(void) {
#ifdef MV_JXLTRAN_VERSION
  return MV_JXLTRAN_VERSION;
#else
  return "jxltran (development build)";
#endif
}

// Message of the last failure of this wrapper; empty after a successful run.
// The tool's own diagnostics are not collected here - they go to stderr.
const char* mv_last_message(void) { return g_last_message.c_str(); }

}  // extern "C"
