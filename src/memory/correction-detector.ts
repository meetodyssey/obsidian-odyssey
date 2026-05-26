import { RetrievedMemory } from "../types";
import { MarkdownStore } from "../store/markdown-store";
import { includesAny, truncateText } from "../utils/text";

interface PendingCorrection {
  targets: string[];
  userMessage: string;
}

export class CorrectionDetector {
  private pending: PendingCorrection | null = null;

  constructor(private readonly store: MarkdownStore) {}

  isCorrectionIntent(message: string): boolean {
    return includesAny(message, [
      "不对", "不是这样", "说错了", "记错了", "其实不是", "更准确", "应该是",
      "not ", "wrong", "actually", "i meant", "i mean", "that's not", "no ",
      "違う", "そうじゃなく", "ちがう",
      "아니", "아니라"
    ]);
  }

  private isConfirmation(message: string): boolean {
    const trimmed = message.trim().toLowerCase();
    if (trimmed.length <= 30) {
      if (/^(yes|yeah|yep|ok|okay|sure|right|correct|please|go ahead|good|confirmed|ya)\b/.test(trimmed)) return true;
      if (/^(对|好|嗯|是的|可以|记录|确认|行|改|修正|对呀|没错)\b/.test(trimmed)) return true;
      if (/^(はい|うん|そう|いい|お願い)\b/.test(trimmed)) return true;
      if (/^(네|응|맞아|그래|좋아)\b/.test(trimmed)) return true;
    }
    return false;
  }

  private isRejection(message: string): boolean {
    const trimmed = message.trim().toLowerCase();
    if (trimmed.length <= 30) {
      if (/^(no|nope|nah|never mind|cancel|skip|don't|stop)\b/.test(trimmed)) return true;
      if (/^(不用|不要|算了|取消|先不|不需要|别|不)\b/.test(trimmed)) return true;
    }
    return false;
  }

  holdCorrectionIntent(message: string, retrieved: RetrievedMemory[]): void {
    if (!this.isCorrectionIntent(message)) return;
    const targets = retrieved
      .filter(item => item.memory.type === "raw_memory" || item.memory.type === "memory_summary")
      .slice(0, 3)
      .map(item => this.store.anchorFor(item.memory.path, item.memory.id));
    if (!targets.length) return;
    this.pending = { targets, userMessage: message };
  }

  async maybeWritePendingCorrection(message: string): Promise<string[]> {
    if (!this.pending) return [];
    if (this.isRejection(message)) {
      this.pending = null;
      return [];
    }
    // Write the correction even if the user doesn't explicitly confirm —
    // they already signalled intent via "记错了/不对/不是这样", and the
    // model acknowledged the error. Requiring an explicit "对/记录" after
    // the model's acknowledgment loses corrections when the user naturally
    // moves on to another topic instead of typing a confirmation word.
    const correction = this.pending;
    this.pending = null;
    const id = await this.store.writeCorrection(
      correction.targets,
      truncateText(correction.userMessage, 500),
      "User indicated a past memory or understanding was inaccurate.",
      `User correction: ${correction.userMessage}\n\nFollow-up: ${message}`
    );
    return [this.store.correctionRecordPath(id)];
  }
}
