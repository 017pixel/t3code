import fs from "node:fs";
const RealDate = Date;
const now = () => Number(fs.readFileSync(process.env.T3_PROOF_CLOCK, "utf8"));
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now()]));
  }
  static now() {
    return now();
  }
};
