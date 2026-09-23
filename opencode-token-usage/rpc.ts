import { Rpc } from "@opencode/plugin/rpc"

export const TokenUsageQuota = Rpc.define({
  id: "token-usage-quota",
  methods: {
    openai: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          windows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                percent: { type: "number" },
                resetsAt: { type: "number" },
                label: { type: "string", enum: ["5h", "Daily", "Weekly", "Monthly"] },
              },
              required: ["percent", "resetsAt", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["windows"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
