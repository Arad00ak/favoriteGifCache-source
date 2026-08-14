/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


export function sniffMime(data: Uint8Array, fallback = "application/octet-stream"): string {
    if (!data || data.byteLength < 4) return fallback;


    if (
        data.byteLength >= 6
        && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
        && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61
    ) {
        return "image/gif";
    }


    if (
        data.byteLength >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    ) {
        return "image/png";
    }


    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return "image/jpeg";
    }


    if (
        data.byteLength >= 12
        && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
        && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
        return "image/webp";
    }


    if (
        data.byteLength >= 12
        && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70
    ) {
        return "video/mp4";
    }


    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
        return "video/webm";
    }

    return fallback;
}
