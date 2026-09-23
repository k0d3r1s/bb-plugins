import { writeChecksums, SOURCE_DIR } from "../src/sync.mjs";
const text = writeChecksums();
process.stdout.write(`wrote ${SOURCE_DIR}/CHECKSUMS\n${text}`);
