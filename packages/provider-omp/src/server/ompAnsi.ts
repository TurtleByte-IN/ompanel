// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and two-byte escapes; C1 CSI (0x9b) too.
const ANSI_PATTERN =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\u001b[@-Z\\-_]/g;

/** Terminal escape handling for text read from an `omp` process. */
export const OmpAnsi = {
  strip: (text: string): string => text.replace(ANSI_PATTERN, ""),
};
