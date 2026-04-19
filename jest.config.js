module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Prefer .ts over .js so ts-jest picks up source files when tsc output
  // co-locates compiled JS alongside TypeScript source (no outDir configured).
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  collectCoverageFrom: [
    'src/lambda/**/*.ts',
    'lib/stacks/**/*.ts',
    '!**/*.d.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
