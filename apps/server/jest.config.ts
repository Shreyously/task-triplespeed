import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1"
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "<rootDir>/tsconfig.json" }]
  },
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testTimeout: 60000,
  maxWorkers: 1
};

export default config;
