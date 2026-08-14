/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const GIF_FORMAT_IMAGE = 1;
export const GIF_FORMAT_VIDEO = 2;

export function isBlobOrDataUrl(url: unknown): url is string {
    return typeof url === "string" && (url.startsWith("blob:") || url.startsWith("data:"));
}

export function isRemoteHttpUrl(url: unknown): url is string {
    return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

export function isVideoMime(mime: string | null | undefined): boolean {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("video/") || m === "application/mp4";
}

export function isImageMime(mime: string | null | undefined): boolean {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("image/");
}

export function mimeMatchesFormat(format: number | undefined, mime: string | null | undefined): boolean {
    const f = typeof format === "number" ? format : GIF_FORMAT_IMAGE;
    if (f === GIF_FORMAT_VIDEO) return isVideoMime(mime);
    if (isVideoMime(mime)) return false;
    if (!mime || mime === "application/octet-stream") return true;
    return isImageMime(mime);
}

export function stashOriginalUrls(gif: any): void {
    if (!gif || typeof gif !== "object") return;

    if (!isRemoteHttpUrl(gif.__fgcOriginalSrc)) {
        if (isRemoteHttpUrl(gif.src)) gif.__fgcOriginalSrc = gif.src;
        else if (isRemoteHttpUrl(gif.url)) gif.__fgcOriginalSrc = gif.url;
    }

    if (!isRemoteHttpUrl(gif.__fgcOriginalUrl)) {
        if (isRemoteHttpUrl(gif.url)) gif.__fgcOriginalUrl = gif.url;
        else if (isRemoteHttpUrl(gif.src)) gif.__fgcOriginalUrl = gif.src;
    }

    if (typeof gif.__fgcOriginalFormat !== "number" && typeof gif.format === "number") {
        gif.__fgcOriginalFormat = gif.format;
    }
}

export function remoteSendUrl(gif: any): string | null {
    if (!gif || typeof gif !== "object") return null;
    for (const c of [
        gif.__fgcOriginalUrl,
        gif.__fgcOriginalSrc,
        isBlobOrDataUrl(gif.url) ? null : gif.url,
        isBlobOrDataUrl(gif.src) ? null : gif.src,
    ]) {
        if (isRemoteHttpUrl(c)) return c;
    }
    return null;
}

export function remoteDisplaySrc(gif: any): string {
    if (!gif || typeof gif !== "object") return "";
    for (const c of [
        gif.__fgcOriginalSrc,
        gif.__fgcOriginalUrl,
        isBlobOrDataUrl(gif.src) ? null : gif.src,
        isBlobOrDataUrl(gif.url) ? null : gif.url,
    ]) {
        if (isRemoteHttpUrl(c)) return c;
    }
    return "";
}

export function restoreUrlsForSend(gif: any): void {
    if (!gif || typeof gif !== "object") return;
    stashOriginalUrls(gif);
    const sendUrl = remoteSendUrl(gif);
    const displaySrc = remoteDisplaySrc(gif) || sendUrl;
    if (sendUrl) gif.url = sendUrl;
    if (displaySrc) gif.src = displaySrc;
    if (typeof gif.__fgcOriginalFormat === "number") gif.format = gif.__fgcOriginalFormat;
}

export function healFavoriteUrls(gif: any): void {
    if (!gif || typeof gif !== "object") return;
    if (isBlobOrDataUrl(gif.src) || isBlobOrDataUrl(gif.url)) restoreUrlsForSend(gif);
}
