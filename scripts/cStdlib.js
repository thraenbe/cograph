// cStdlib.js — which standard header declares a C library function.
//
// The C analyzer turns a call to a name that no workspace file defines or
// declares into a library node when the name is a C standard library (or
// everyday POSIX) function, attributed to its header's stem — `printf` →
// "stdio", `memcpy` → "string" — the way the Python analyzer names libraries
// by module. Names outside this table are dropped: C has no import that would
// say which library a third-party call belongs to.
'use strict';

const HEADERS = {
  assert: 'assert static_assert',
  ctype: 'isalnum isalpha isblank iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper',
  inttypes: 'imaxabs imaxdiv strtoimax strtoumax',
  locale: 'setlocale localeconv',
  math: 'fabs fmod remainder fma fmax fmin fdim nan exp exp2 expm1 log log10 log2 log1p pow sqrt cbrt hypot sin cos tan asin acos atan atan2 '
    + 'sinh cosh tanh asinh acosh atanh erf erfc tgamma lgamma ceil floor trunc round lround llround nearbyint rint lrint frexp ldexp '
    + 'modf scalbn ilogb logb nextafter copysign isnan isinf isfinite signbit fabsf sqrtf powf sinf cosf floorf ceilf roundf fmodf',
  setjmp: 'setjmp longjmp',
  signal: 'signal raise sigaction sigemptyset sigaddset sigprocmask kill',
  stdarg: 'va_start va_arg va_end va_copy',
  stdio: 'printf fprintf sprintf snprintf vprintf vfprintf vsprintf vsnprintf scanf fscanf sscanf vscanf vfscanf vsscanf '
    + 'fopen freopen fclose fflush fread fwrite fgetc getc getchar fgets fputc putc putchar fputs puts ungetc '
    + 'fseek ftell rewind fgetpos fsetpos feof ferror clearerr remove rename tmpfile tmpnam setbuf setvbuf '
    + 'fileno fdopen getline getdelim dprintf popen pclose perror',
  stdlib: 'malloc calloc realloc free aligned_alloc abort exit atexit quick_exit at_quick_exit _Exit getenv setenv unsetenv system '
    + 'atoi atol atoll atof strtol strtoll strtoul strtoull strtof strtod strtold rand srand random srandom '
    + 'qsort bsearch abs labs llabs div ldiv lldiv mblen mbtowc wctomb mbstowcs wcstombs realpath mkstemp',
  string: 'memcpy memmove memset memcmp memchr strcpy strncpy strcat strncat strcmp strncmp strcoll strxfrm '
    + 'strchr strrchr strspn strcspn strpbrk strstr strtok strtok_r strlen strnlen strdup strndup strcasecmp strncasecmp '
    + 'memccpy stpcpy stpncpy strsep strlcpy strlcat strerror',
  time: 'time clock difftime mktime asctime ctime gmtime localtime strftime timespec_get nanosleep gettimeofday clock_gettime',
  wchar: 'wprintf fwprintf swprintf wscanf wcslen wcscpy wcsncpy wcscat wcscmp wcsncmp wcschr wcsstr wcstol wcstod mbrtowc wcrtomb',
  wctype: 'iswalpha iswdigit iswspace iswupper iswlower towlower towupper',
  threads: 'thrd_create thrd_join thrd_detach thrd_current thrd_sleep thrd_yield thrd_exit mtx_init mtx_lock mtx_unlock mtx_destroy '
    + 'cnd_init cnd_signal cnd_broadcast cnd_wait cnd_destroy tss_create tss_get tss_set',
  stdatomic: 'atomic_init atomic_store atomic_load atomic_exchange atomic_compare_exchange_strong atomic_compare_exchange_weak '
    + 'atomic_fetch_add atomic_fetch_sub atomic_fetch_or atomic_fetch_and atomic_thread_fence atomic_flag_test_and_set atomic_flag_clear',
  // Everyday POSIX, the part of "libc" most C projects call without thinking.
  unistd: 'read write close lseek pipe dup dup2 fork execv execvp execve _exit getpid getppid sleep usleep isatty unlink rmdir chdir getcwd access ftruncate fsync pread pwrite',
  fcntl: 'open openat creat fcntl',
  pthread: 'pthread_create pthread_join pthread_detach pthread_self pthread_exit pthread_mutex_init pthread_mutex_lock pthread_mutex_unlock '
    + 'pthread_mutex_destroy pthread_cond_init pthread_cond_wait pthread_cond_signal pthread_cond_broadcast pthread_cond_destroy pthread_once',
};

const BY_NAME = new Map();
for (const [stem, names] of Object.entries(HEADERS)) {
  for (const name of names.split(' ')) { if (name) { BY_NAME.set(name, stem); } }
}

/** Header stem ("stdio", "string", …) of a C library function, or null. */
function libraryOf(name) {
  return BY_NAME.get(name) ?? null;
}

module.exports = { libraryOf };
