declare module 'paddleocr-js' {
  import type { OcrEngine } from '../main/ocr/engine';
  /** 可选依赖：安装包内置 PaddleOCR-js 时启用真实 PP-OCR 推理后端 */
  export function createEngine(): PromiseLike<OcrEngine>;
}
