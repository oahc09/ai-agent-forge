.code16
.global _start
_start:
    cli
    xorw %ax, %ax
    movw %ax, %ds
    cld
    movw $message, %si
    movw $0xe9, %dx
emit:
    lodsb
    testb %al, %al
    jz finish
    outb %al, %dx
    jmp emit
finish:
    movw $0xf4, %dx
    movw $0x2a, %ax
    outw %ax, %dx
stop:
    hlt
    jmp stop
message:
    .asciz "FORGE_TCG_INERT_BOOT_OK\n"
.org 510
.word 0xaa55
