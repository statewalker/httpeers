import { memoryConfigStore } from "../src/core/config.js";
import { memorySessionStore } from "../src/core/sessions.js";
import { describeConfigStoreContract } from "./contracts/config-store.contract.js";
import { describeSessionStoreContract } from "./contracts/session-store.contract.js";

describeSessionStoreContract("memory", (clock) => memorySessionStore(clock));
describeConfigStoreContract("memory", () => memoryConfigStore());
