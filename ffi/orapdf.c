// PDF page renderer for Ora. This machine's PDFium library (fetched by scripts/fetch-pdfium.ts) is embedded in this
// archive, loaded at first use without leaving a file behind, and driven through dlsym.
// One document is open at a time; pages come out as JPEG through ora_pdf_render + ora_pdf_copy.
#define _GNU_SOURCE
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#include <sys/mman.h>
#include <unistd.h>
#endif

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "vendor/stb_image_write.h"

extern const unsigned char ora_pdfium_start[];
extern const unsigned char ora_pdfium_end[];
#if defined(__APPLE__)
#define ORA_SYM(n) "_" #n
#define ORA_SECTION ".section __DATA,__const\n"
#elif defined(_WIN32)
#define ORA_SYM(n) #n
#define ORA_SECTION ".section .rdata,\"dr\"\n"
#elif defined(__linux__)
#define ORA_SYM(n) #n
#define ORA_SECTION ".section .rodata\n"
#else
#error "orapdf.c supports Linux, macOS and Windows only"
#endif
__asm__(ORA_SECTION
        ".balign 16\n"
        ".globl " ORA_SYM(ora_pdfium_start) "\n" ORA_SYM(ora_pdfium_start) ":\n"
        ".incbin \"" ORA_PDFIUM_LIB "\"\n"
        ".globl " ORA_SYM(ora_pdfium_end) "\n" ORA_SYM(ora_pdfium_end) ":\n"
        ".text\n");

enum { ERR_NO_DOC = -1, ERR_BAD_PAGE = -2, ERR_LOAD_PAGE = -3, ERR_ENCODE = -4, ERR_LIB = -100 };
enum { MAX_PX = 4096 };
enum { FORMAT_BGRX = 3, RENDER_ANNOT = 1 };  // FPDFBitmap_BGRx: 4 bytes per pixel (2 is 3-byte BGR)

static struct {
    void (*init)(void);
    void *(*load_mem)(const void *, int, const char *);
    int (*page_count)(void *);
    void *(*load_page)(void *, int);
    float (*page_w)(void *);
    float (*page_h)(void *);
    void (*close_page)(void *);
    void (*close_doc)(void *);
    void *(*bitmap_create)(int, int, int, void *, int);
    void (*bitmap_fill)(void *, int, int, int, int, uint32_t);
    void (*bitmap_destroy)(void *);
    void (*render)(void *, void *, int, int, int, int, int, int);
    unsigned long (*last_error)(void);
    void *(*text_load)(void *);
    int (*text_count)(void *);
    int (*text_get)(void *, int, int, unsigned short *);
    void (*text_close)(void *);
} P;

static int loaded;
static void *doc;
static uint8_t *doc_data;
static uint8_t *jpg;
static size_t jpg_len, jpg_cap;

#if defined(_WIN32)
#define LIB_OPEN(path) ((void *)LoadLibraryA(path))
#define LIB_SYM(h, name) ((void *)GetProcAddress((HMODULE)(h), name))

// Windows cannot delete a DLL while it is loaded, so the library lives in the temp folder under a name that
// carries its size and is reused when already there (a rewrite would fail while another Ora has it loaded).
static void *open_embedded(void) {
    size_t n = (size_t)(ora_pdfium_end - ora_pdfium_start);
    char dir[MAX_PATH], path[MAX_PATH + 64];
    DWORD len = GetTempPathA(sizeof dir, dir);
    if (len == 0 || len >= sizeof dir) return NULL;
    snprintf(path, sizeof path, "%sora-pdfium-%zu.dll", dir, n);
    WIN32_FILE_ATTRIBUTE_DATA info;
    int fresh = !(GetFileAttributesExA(path, GetFileExInfoStandard, &info) && info.nFileSizeHigh == 0 &&
                  info.nFileSizeLow == (DWORD)n);
    if (fresh) {
        char tmp[MAX_PATH + 64];
        snprintf(tmp, sizeof tmp, "%s.%lu.tmp", path, (unsigned long)GetCurrentProcessId());
        HANDLE f = CreateFileA(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, NULL);
        if (f == INVALID_HANDLE_VALUE) return NULL;
        DWORD wrote = 0;
        BOOL ok = WriteFile(f, ora_pdfium_start, (DWORD)n, &wrote, NULL) && wrote == (DWORD)n;
        CloseHandle(f);
        if (!ok || !MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING)) {
            DeleteFileA(tmp);
            if (!ok) return NULL;
        }
    }
    return LIB_OPEN(path);
}
#else
#define LIB_OPEN(path) dlopen(path, RTLD_NOW | RTLD_LOCAL)
#define LIB_SYM(h, name) dlsym(h, name)

static int write_all(int fd, const unsigned char *p, size_t n) {
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

// Opens the embedded library without leaving anything behind: an anonymous in-memory file on Linux, otherwise
// (macOS, or Linux without memfd) a temp file that is deleted as soon as the loader has it.
static void *open_embedded(void) {
    size_t n = (size_t)(ora_pdfium_end - ora_pdfium_start);
#if defined(__linux__)
    int mfd = memfd_create("pdfium", 0);
    if (mfd >= 0) {
        void *h = NULL;
        if (write_all(mfd, ora_pdfium_start, n) == 0) {
            char path[64];
            snprintf(path, sizeof path, "/proc/self/fd/%d", mfd);
            h = LIB_OPEN(path);
        }
        close(mfd);
        if (h) return h;
    }
#endif
    const char *dir = getenv("TMPDIR");
    if (!dir || !*dir) dir = "/tmp";
    char path[1024];
    snprintf(path, sizeof path, "%s/ora-pdfium-XXXXXX", dir);
    int fd = mkstemp(path);
    if (fd < 0) return NULL;
    int ok = write_all(fd, ora_pdfium_start, n) == 0;
    close(fd);
    void *h = ok ? LIB_OPEN(path) : NULL;
    unlink(path);
    return h;
}
#endif

static int load_lib(void) {
    if (loaded) return 0;
    void *h = open_embedded();
    if (!h) return ERR_LIB;
#define SYM(field, name) if (!(*(void **)&P.field = LIB_SYM(h, name))) return ERR_LIB
    SYM(init, "FPDF_InitLibrary");
    SYM(load_mem, "FPDF_LoadMemDocument");
    SYM(page_count, "FPDF_GetPageCount");
    SYM(load_page, "FPDF_LoadPage");
    SYM(page_w, "FPDF_GetPageWidthF");
    SYM(page_h, "FPDF_GetPageHeightF");
    SYM(close_page, "FPDF_ClosePage");
    SYM(close_doc, "FPDF_CloseDocument");
    SYM(bitmap_create, "FPDFBitmap_CreateEx");
    SYM(bitmap_fill, "FPDFBitmap_FillRect");
    SYM(bitmap_destroy, "FPDFBitmap_Destroy");
    SYM(render, "FPDF_RenderPageBitmap");
    SYM(last_error, "FPDF_GetLastError");
    SYM(text_load, "FPDFText_LoadPage");
    SYM(text_count, "FPDFText_CountChars");
    SYM(text_get, "FPDFText_GetText");
    SYM(text_close, "FPDFText_ClosePage");
#undef SYM
    P.init();
    loaded = 1;
    return 0;
}

int32_t ora_pdf_close(void) {
    if (doc) P.close_doc(doc);
    doc = NULL;
    free(doc_data);
    doc_data = NULL;
    return 0;
}

// Returns the page count, or a negative error: ERR_LIB, or minus PDFium's FPDF_GetLastError code.
int32_t ora_pdf_open(uint8_t *data, size_t len) {
    int rc = load_lib();
    if (rc) return rc;
    ora_pdf_close();
    doc_data = malloc(len ? len : 1);
    if (!doc_data) return ERR_LIB;
    memcpy(doc_data, data, len);
    doc = P.load_mem(doc_data, (int)len, NULL);
    if (!doc) {
        int code = (int)P.last_error();
        ora_pdf_close();
        return code ? -code : ERR_LIB;
    }
    return P.page_count(doc);
}

static int sink_failed;

static void sink(void *ctx, void *data, int size) {
    (void)ctx;
    if (sink_failed) return;
    if (jpg_len + (size_t)size > jpg_cap) {
        size_t cap = jpg_cap ? jpg_cap : 65536;
        while (cap < jpg_len + (size_t)size) cap *= 2;
        uint8_t *grown = realloc(jpg, cap);
        if (!grown) {
            sink_failed = 1;
            return;
        }
        jpg = grown;
        jpg_cap = cap;
    }
    memcpy(jpg + jpg_len, data, (size_t)size);
    jpg_len += (size_t)size;
}

static uint8_t *rgb_buf;
static int rgb_w, rgb_h;

// Renders one page to RGB in rgb_buf so its longest side is max_px. Returns 0 or a negative error.
static int render_rgb(int32_t index, int32_t max_px) {
    if (!doc) return ERR_NO_DOC;
    if (index < 0 || index >= P.page_count(doc)) return ERR_BAD_PAGE;
    void *page = P.load_page(doc, index);
    if (!page) return ERR_LOAD_PAGE;
    float w = P.page_w(page), h = P.page_h(page);
    if (!(w > 0.0f && h > 0.0f) || max_px < 1 || max_px > MAX_PX) {
        P.close_page(page);
        return ERR_LOAD_PAGE;
    }
    float scale = (float)max_px / (w > h ? w : h);
    int pw = (int)lroundf(w * scale), ph = (int)lroundf(h * scale);
    if (pw < 1) pw = 1;
    if (ph < 1) ph = 1;
    int result = ERR_ENCODE;
    free(rgb_buf);
    rgb_buf = malloc((size_t)pw * (size_t)ph * 3);
    uint8_t *px = malloc((size_t)pw * (size_t)ph * 4);
    if (px && rgb_buf) {
        void *bm = P.bitmap_create(pw, ph, FORMAT_BGRX, px, pw * 4);
        if (bm) {
            P.bitmap_fill(bm, 0, 0, pw, ph, 0xFFFFFFFFu);
            P.render(bm, page, 0, 0, pw, ph, 0, RENDER_ANNOT);
            for (size_t i = 0, n = (size_t)pw * (size_t)ph; i < n; i++) {
                rgb_buf[i * 3] = px[i * 4 + 2];
                rgb_buf[i * 3 + 1] = px[i * 4 + 1];
                rgb_buf[i * 3 + 2] = px[i * 4];
            }
            rgb_w = pw;
            rgb_h = ph;
            result = 0;
            P.bitmap_destroy(bm);
        }
    }
    free(px);
    P.close_page(page);
    return result;
}

// Renders one page and keeps the JPEG inside until ora_pdf_copy. Returns its size.
int32_t ora_pdf_render(int32_t index, int32_t max_px, int32_t quality) {
    int rc = render_rgb(index, max_px);
    if (rc) return rc;
    jpg_len = 0;
    sink_failed = 0;
    if (stbi_write_jpg_to_func(sink, NULL, rgb_w, rgb_h, 3, rgb_buf, quality) && jpg_len && !sink_failed) return (int32_t)jpg_len;
    return ERR_ENCODE;
}

// Renders one page and keeps the raw RGB inside until ora_pdf_copy_raw. Returns width * 8192 + height.
int32_t ora_pdf_render_raw(int32_t index, int32_t max_px) {
    int rc = render_rgb(index, max_px);
    return rc ? rc : rgb_w * 8192 + rgb_h;
}

int32_t ora_pdf_copy_raw(uint8_t *out, size_t cap) {
    size_t n = (size_t)rgb_w * (size_t)rgb_h * 3;
    if (!rgb_buf || n > cap) return ERR_ENCODE;
    memcpy(out, rgb_buf, n);
    return (int32_t)n;
}

int32_t ora_pdf_copy(uint8_t *out, size_t cap) {
    size_t n = jpg_len < cap ? jpg_len : cap;
    memcpy(out, jpg, n);
    return (int32_t)n;
}

enum { MAX_TEXT_CHARS = 1 << 16 };
static uint8_t *txt;
static size_t txt_len;

// UTF-16 from PDFium to UTF-8 in txt (sized for 3 bytes per unit). Unpaired surrogates become U+FFFD.
static void utf16_to_txt(const unsigned short *u, int n) {
    txt_len = 0;
    for (int i = 0; i < n; i++) {
        uint32_t c = u[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (u[i + 1] - 0xDC00);
            i++;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
            c = 0xFFFD;
        }
        if (c < 0x80) {
            txt[txt_len++] = (uint8_t)c;
        } else if (c < 0x800) {
            txt[txt_len++] = (uint8_t)(0xC0 | (c >> 6));
            txt[txt_len++] = (uint8_t)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            txt[txt_len++] = (uint8_t)(0xE0 | (c >> 12));
            txt[txt_len++] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
            txt[txt_len++] = (uint8_t)(0x80 | (c & 0x3F));
        } else {
            txt[txt_len++] = (uint8_t)(0xF0 | (c >> 18));
            txt[txt_len++] = (uint8_t)(0x80 | ((c >> 12) & 0x3F));
            txt[txt_len++] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
            txt[txt_len++] = (uint8_t)(0x80 | (c & 0x3F));
        }
    }
}

// Extracts one page's text layer as UTF-8 and keeps it until ora_pdf_copy_text. Returns its byte length (0 for a
// page without text), or a negative error. The text only ranks pages; the model is sent page images.
int32_t ora_pdf_page_text(int32_t index) {
    if (!doc) return ERR_NO_DOC;
    if (index < 0 || index >= P.page_count(doc)) return ERR_BAD_PAGE;
    void *page = P.load_page(doc, index);
    if (!page) return ERR_LOAD_PAGE;
    txt_len = 0;
    int result = 0;
    void *tp = P.text_load(page);
    if (tp) {
        int n = P.text_count(tp);
        if (n > MAX_TEXT_CHARS) n = MAX_TEXT_CHARS;
        if (n > 0) {
            unsigned short *u = malloc(((size_t)n + 1) * sizeof *u);
            uint8_t *grown = realloc(txt, (size_t)n * 3 + 1);
            if (grown) txt = grown;
            if (u && grown) {
                int got = P.text_get(tp, 0, n, u);
                if (got > 0 && u[got - 1] == 0) got--;
                utf16_to_txt(u, got > n ? n : got);
            } else {
                result = ERR_ENCODE;
            }
            free(u);
        }
        P.text_close(tp);
    }
    P.close_page(page);
    return result < 0 ? result : (int32_t)txt_len;
}

int32_t ora_pdf_copy_text(uint8_t *out, size_t cap) {
    size_t n = txt_len < cap ? txt_len : cap;
    if (n) memcpy(out, txt, n);
    return (int32_t)n;
}
