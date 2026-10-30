export interface BridgeTarget {
  target: string;
  os: "linux" | "darwin" | "windows";
  file: string;
}
export declare const TARGETS: BridgeTarget[];
