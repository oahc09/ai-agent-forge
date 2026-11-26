# Private helper for the fixed QEMU and host calibration callers.
# The CLI entrypoints never forward caller-supplied commands or paths to run.
inert_limits() {
    prlimit --cpu=30:31 --fsize=65536:65536 --nofile=128:128 --core=0:0 -- "$@"
}
