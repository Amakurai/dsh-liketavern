/** 模板头像只携带有界的 PNG 图像块；剥离角色卡元数据和尾随数据，不接受脚本或外部地址。 */
export const TEMPLATE_AVATAR_BYTES = 384 * 1024;
export const TEMPLATE_AVATAR_URL_CHARS = 524310;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const retained = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
export function templateAvatarPng(input) {
    if (input.length > 32 * 1024 * 1024 || input.length < 8 || signature.some((value, index) => input[index] !== value))
        return null;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const chunks = [input.subarray(0, 8)];
    let offset = 8, size = 8, header = false, image = false, ended = false;
    while (offset + 12 <= input.length) {
        const length = view.getUint32(offset), end = offset + 12 + length;
        if (end > input.length)
            return null;
        const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
        if (!header && type !== 'IHDR')
            return null;
        if (type === 'IHDR') {
            if (header || length !== 13 || !view.getUint32(offset + 8) || !view.getUint32(offset + 12))
                return null;
            header = true;
        }
        if (type === 'IDAT')
            image = true;
        if (type === 'IEND') {
            if (length || !image)
                return null;
            ended = true;
        }
        if (retained.has(type)) {
            size += length + 12;
            if (size > TEMPLATE_AVATAR_BYTES)
                return null;
            chunks.push(input.subarray(offset, end));
        }
        offset = end;
        if (ended)
            break;
    }
    if (!header || !image || !ended)
        return null;
    const result = new Uint8Array(size);
    offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}
export function isTemplateAvatarUrl(value) {
    return typeof value === 'string' && value.length <= TEMPLATE_AVATAR_URL_CHARS
        && (value === '' || /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
}
