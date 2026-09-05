export async function collectCompleteText(stream, signal) {
    const iterator = stream[Symbol.asyncIterator]();
    let text = '';
    let complete = false;
    let onAbort = () => { };
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('生成已取消'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
    });
    try {
        while (true) {
            const item = await Promise.race([iterator.next(), aborted]);
            if (item.done)
                break;
            const chunk = item.value;
            if (complete)
                throw new Error('模型在终止帧后继续发送内容');
            if (chunk.type === 'text-delta') {
                text += chunk.text;
                if (text.length > 100_000)
                    throw new Error('辅助生成正文超过上限');
            }
            else if (chunk.type === 'finish') {
                if (chunk.reason.kind !== 'stop')
                    throw new Error(`模型未正常完成：${chunk.reason.kind}`);
                complete = true;
            }
        }
        if (!complete || !text.trim())
            throw new Error('模型未返回完整正文和成功终止帧');
        return text.trim();
    }
    finally {
        signal.removeEventListener('abort', onAbort);
        // 不等待忽略取消信号的适配器关闭，否则超时本身也会挂住维护队列。
        void iterator.return?.().catch(() => { });
    }
}
