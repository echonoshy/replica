/**
 * Copy text to clipboard with fallback for HTTP environments
 * Works in both HTTPS and HTTP contexts
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Try modern Clipboard API first (works in HTTPS/localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn("Clipboard API failed, trying fallback:", err);
    }
  }

  // Fallback for HTTP environments
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);

    return successful;
  } catch (err) {
    console.error("Fallback copy failed:", err);
    return false;
  }
}
