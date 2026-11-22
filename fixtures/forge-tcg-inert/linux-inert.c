#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/limits.h>
#include <net/if.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/io.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <unistd.h>
#ifndef HOST_ONLY_CANARY
#error HOST_ONLY_CANARY must point to the scoped inert host fixture
#endif

static void print_debug(const char *line) {
    while (*line) outb((unsigned char) *line++, 0xe9);
    outb('\n', 0xe9);
}
static void stop(bool pass) {
    outw(pass ? 0x2a : 0x2b, 0xf4);
    for (;;) pause();
}
int main(void) {
    if (ioperm(0xe9, 1, 1) || ioperm(0xf4, 2, 1)) return 1;
    if (mount("proc", "/proc", "proc", MS_NOSUID|MS_NODEV|MS_NOEXEC, "") ||
        mount("sysfs", "/sys", "sysfs", MS_NOSUID|MS_NODEV|MS_NOEXEC|MS_RDONLY, "")) {
        print_debug("FAIL_PROBE_FILESYSTEM"); stop(false);
    }
    char cmdline[1024];
    FILE *proc = fopen("/proc/cmdline", "re");
    if (!proc || !fgets(cmdline, sizeof(cmdline), proc)) { print_debug("FAIL_CMDLINE"); stop(false); }
    fclose(proc);
    if (strstr(cmdline, "forge.expect=negative")) { print_debug("EXPECTED_NEGATIVE_FIXTURE"); stop(false); }
    errno = 0;
    if (access(HOST_ONLY_CANARY, F_OK) == 0 || errno != ENOENT) {
        print_debug("FAIL_GUEST_SAW_HOST_PATH"); stop(false);
    }
    errno = 0;
    FILE *test = fopen("/guest-only", "wex");
    if (!test || fputs("inert initramfs-only write\n", test) < 0 || fclose(test)) {
        print_debug("FAIL_GUEST_RAM_WRITE"); stop(false);
    }
    DIR *nics = opendir("/sys/class/net");
    if (!nics) { print_debug("FAIL_GUEST_NETWORK_INVENTORY"); stop(false); }
    int count = 0; bool only_loopback = true;
    for (struct dirent *e; (e = readdir(nics)) != NULL;) {
        if (e->d_name[0] == '.') continue;
        count++;
        if (strcmp(e->d_name, "lo")) only_loopback = false;
    }
    closedir(nics);
    if (!only_loopback || count != 1) { print_debug("FAIL_GUEST_NIC_PRESENT"); stop(false); }
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    struct sockaddr_in dst = {.sin_family = AF_INET, .sin_port = htons(9)};
    inet_pton(AF_INET, "192.0.2.1", &dst.sin_addr);
    errno = 0;
    if (fd < 0 || connect(fd, (const struct sockaddr *)&dst, sizeof(dst)) != -1 || errno != ENETUNREACH) {
        print_debug("FAIL_GUEST_UNEXPECTED_ROUTE"); stop(false);
    }
    close(fd);
    struct utsname u;
    if (uname(&u) != 0) { print_debug("FAIL_GUEST_KERNEL"); stop(false); }
    print_debug(u.release);
    print_debug("FORGE_TCG_INERT_LINUX_OK");
    stop(true);
}
