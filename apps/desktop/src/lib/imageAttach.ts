/**
 * Preparo de imagem colada/anexada para virar conteúdo de visão.
 *
 * Prints em 4K viram ~8 MB de base64 e estouram a janela do modelo — por isso
 * a imagem é redimensionada (lado maior limitado) e recodificada em JPEG antes
 * de virar anexo. Puro o suficiente para testar a parte de cálculo.
 */
export const MAX_IMAGE_SIDE = 1600;
export const JPEG_QUALITY = 0.82;

/** Calcula o tamanho final preservando proporção, sem AMPLIAR imagem pequena. */
export function fitWithin(width: number, height: number, maxSide = MAX_IMAGE_SIDE): { width: number; height: number } {
  const largest = Math.max(width, height);
  if (largest <= maxSide || largest === 0) return { width, height };
  const scale = maxSide / largest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** true para MIME de imagem que o canvas consegue recodificar. */
export function isResizableImage(type: string): boolean {
  return /^image\/(png|jpe?g|webp|bmp)$/i.test(type);
}

/**
 * Redimensiona e converte para data URL JPEG. GIF/SVG passam sem tocar (GIF
 * perderia a animação; SVG não é raster).
 */
export async function toAttachmentDataUrl(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (!isResizableImage(file.type)) return original;
  try {
    const image = await loadImage(original);
    const target = fitWithin(image.naturalWidth, image.naturalHeight);
    if (target.width === image.naturalWidth && target.height === image.naturalHeight && file.size < 900_000) {
      return original;
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return original;
    context.drawImage(image, 0, 0, target.width, target.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch {
    return original;
  }
}

/** Lê qualquer arquivo como data URL (vídeo, áudio, PDF — sem recodificar). */
export function fileToDataUrl(file: File): Promise<string> {
  return readAsDataUrl(file);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("imagem inválida"));
    image.src = src;
  });
}
