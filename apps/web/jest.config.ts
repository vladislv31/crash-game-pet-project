import type { Config } from 'jest';

// Unit tests cover the pure client logic; ts-jest compiles it as CommonJS for Node.
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { module: 'nodenext', moduleResolution: 'nodenext', jsx: 'react-jsx' } },
    ],
  },
  testEnvironment: 'node',
};

export default config;
