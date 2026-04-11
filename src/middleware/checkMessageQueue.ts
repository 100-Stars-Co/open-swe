import { createMiddleware } from "langchain";
import { getAgentStateStore } from "../state/index.js";

export const checkMessageQueueMiddleware = createMiddleware({
  name: "CheckMessageQueue",
  beforeModel: async () => {
    return {};
  },
});

export async function queueMessageForThread(threadId: string, message: string): Promise<void> {
  await getAgentStateStore().enqueueMessage(threadId, message);
}
