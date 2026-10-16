/* Optional Linux hardening for hub process isolation.
 * Compiled on demand when a C compiler is present. Bubblewrap remains the boundary
 * if this helper cannot be built. The helper applies landlock, then seccomp, then execs.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/prctl.h>
#include <linux/seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

static int ll_create(const void *attr, size_t size, int flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static int ll_add(int fd, int type, const void *attr) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, 0);
}
static int ll_restrict(int fd) {
  return (int)syscall(__NR_landlock_restrict_self, fd, 0);
}

static void fail(void) { _exit(2); }

static uint64_t handled_fs(int abi) {
  uint64_t bits = (1ULL << 13) - 1; /* execute through make_sym */
  if (abi >= 2) bits |= (1ULL << 13); /* refer */
  if (abi >= 3) bits |= (1ULL << 14); /* truncate */
  return bits;
}

static uint64_t read_bits(void) {
  return (1ULL << 0) | (1ULL << 2) | (1ULL << 3); /* execute, read file, read dir */
}
static uint64_t write_bits(int abi) {
  uint64_t bits = read_bits() | (1ULL << 1) | (1ULL << 4) | (1ULL << 5) | (1ULL << 7) | (1ULL << 8) | (1ULL << 12);
  if (abi >= 2) bits |= (1ULL << 13);
  if (abi >= 3) bits |= (1ULL << 14);
  return bits;
}

static void add_path(int ruleset, const char *path, uint64_t access, uint64_t handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) fail();
  struct landlock_path_beneath_attr attr = {.allowed_access = access & handled, .parent_fd = fd};
  int added = ll_add(ruleset, LANDLOCK_RULE_PATH_BENEATH, &attr);
  close(fd);
  if (added != 0) fail();
}

static void add_port(int ruleset, uint64_t port) {
  struct landlock_net_port_attr attr = {.allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP, .port = port};
  if (ll_add(ruleset, LANDLOCK_RULE_NET_PORT, &attr) != 0) fail();
}

static void install_seccomp(const char *path) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) fail();
  struct sock_filter filters[512];
  size_t got = 0;
  while (got < sizeof filters) {
    ssize_t n = read(fd, (char *)filters + got, sizeof filters - got);
    if (n < 0) fail();
    if (n == 0) break;
    got += (size_t)n;
  }
  close(fd);
  if (got == 0 || got % sizeof(struct sock_filter) != 0 || got == sizeof filters) fail();
  struct sock_fprog prog = {.len = (unsigned short)(got / sizeof(struct sock_filter)), .filter = filters};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) fail();
}

int main(int argc, char **argv) {
  int abi = ll_create(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    if (abi < 1) return 2;
    printf("%d\n", abi);
    return 0;
  }
  if (argc < 4 || abi < 1) fail();
  const char *policy = argv[1];
  int dash = -1;
  for (int i = 2; i < argc; i++) if (strcmp(argv[i], "--") == 0) { dash = i; break; }
  if (dash < 0 || dash + 1 >= argc) fail();

  struct landlock_ruleset_attr rules = {0};
  rules.handled_access_fs = handled_fs(abi);
  size_t rules_size = sizeof rules.handled_access_fs;
  int restrict_net = 0;
  if (abi >= 4) {
    rules.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
    rules_size = sizeof rules;
    restrict_net = 1;
  }
  int ruleset = ll_create(&rules, rules_size, 0);
  if (ruleset < 0) fail();

  FILE *file = fopen(policy, "r");
  if (!file) fail();
  char line[8192];
  char seccomp[4096] = {0};
  while (fgets(line, sizeof line, file)) {
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    if (len < 2 || line[1] != '\t') fail();
    const char *value = line + 2;
    if (line[0] == 'R') add_path(ruleset, value, read_bits(), rules.handled_access_fs);
    else if (line[0] == 'W') add_path(ruleset, value, write_bits(abi), rules.handled_access_fs);
    else if (line[0] == 'P') {
      if (!restrict_net) fail();
      char *end = NULL;
      unsigned long port = strtoul(value, &end, 10);
      if (!end || *end || port < 1 || port > 65535) fail();
      add_port(ruleset, port);
    } else if (line[0] == 'S') {
      if (strlen(value) >= sizeof seccomp) fail();
      memcpy(seccomp, value, strlen(value) + 1);
    } else fail();
  }
  fclose(file);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail();
  if (ll_restrict(ruleset) != 0) fail();
  close(ruleset);
  if (seccomp[0]) install_seccomp(seccomp);
  execvp(argv[dash + 1], argv + dash + 1);
  fail();
}
