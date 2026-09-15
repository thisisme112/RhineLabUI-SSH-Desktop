import { registerPlugin } from "@capacitor/core";
export const documents = registerPlugin<{
  pickKey(): Promise<{ canceled?: boolean; name?: string; content?: string }>;
  pickFiles(options: { directory?: boolean }): Promise<{ canceled?: boolean; paths: string[]; root: string }>;
  downloadTarget(): Promise<{ canceled?: boolean; directory: string; uri: string }>;
  publish(options: { path: string; uri: string }): Promise<{ file: string }>;
  cleanup(options: { path: string }): Promise<void>;
  exportText(options: { suggestedName: string; text: string }): Promise<{ canceled?: boolean; file?: string }>;
  readClipboard(): Promise<{ text: string }>;
  writeClipboard(options: { text: string }): Promise<void>;
}>("SshDocuments");
