import fs from "node:fs";
import {
  consumeWorkerLaunchNonce,
} from "../../services/worker-launch-consume-helper.mjs";

process.env.NODE_ENV = "test";

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

try {
  const receipt = consumeWorkerLaunchNonce(
    job.envelope,
    Buffer.from(job.challenge, "base64url"),
    {
      root: job.root,
      testPrivateKey: fs.readFileSync(job.privateKeyPath),
      testPublicKey: fs.readFileSync(job.publicKeyPath),
      aclVerifier: () => true,
      launcherInstanceEvidence: job.launcherInstanceEvidence,
    },
  );
  process.stdout.write(JSON.stringify({ ok: true, receipt }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error?.code || "UNKNOWN",
  }));
}
