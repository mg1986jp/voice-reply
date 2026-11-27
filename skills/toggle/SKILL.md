---
description: voice-reply の読み上げをオン・オフする。on か off を付けるとその状態にし、付けなければ今と逆にする。
argument-hint: "[on|off]"
disable-model-invocation: true
---

voice-reply の読み上げの切り替えは、このコマンドを受けたフックがすでに済ませている。フックから届いた結果（オンにしたか、オフにしたか、切り替えられなかったか）を、ユーザーに一言で伝える。ファイルの読み書きやコマンドの実行など、ほかの作業はしない。

フックからの結果が届いていないときは、切り替えられなかったことを伝え、Claude Code を新しくするよう案内する（このコマンドは UserPromptExpansion フックで切り替える）。
