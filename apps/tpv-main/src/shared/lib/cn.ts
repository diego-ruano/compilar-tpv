// src/shared/lib/cn.ts
// Une clases condicionalmente (filtra falsy y junta con espacios).
export function cn(...classes: Array<string | false | undefined | null>): string {
    return classes.filter(Boolean).join(" ");
}
