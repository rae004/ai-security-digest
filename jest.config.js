module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
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
