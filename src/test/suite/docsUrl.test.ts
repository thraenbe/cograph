import * as assert from 'assert';
import { docsUrl } from '../../docsUrl';

suite('docsUrl', () => {
  test('python: the top-level module', () => {
    assert.strictEqual(docsUrl({ libraryName: 'os.path', language: 'python' }), 'https://docs.python.org/3/library/os');
  });

  test('java: the JDK package page, else javadoc.io', () => {
    assert.strictEqual(docsUrl({ libraryName: 'java.util.concurrent', language: 'java' }),
      'https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html');
    assert.strictEqual(docsUrl({ libraryName: 'javax.net', language: 'java' }),
      'https://docs.oracle.com/en/java/javase/21/docs/api/java.base/javax/net/package-summary.html');
    assert.strictEqual(docsUrl({ libraryName: 'com.google.guava', language: 'java' }), 'https://javadoc.io/doc/com.google.guava');
  });

  test('cpp: a search for library::function, encoded', () => {
    assert.strictEqual(docsUrl({ libraryName: 'std', functionName: 'sort', language: 'cpp' }),
      'https://en.cppreference.com/mwiki/index.php?search=std%3A%3Asort');
    assert.strictEqual(docsUrl({ libraryName: 'std', language: 'cpp' }),
      'https://en.cppreference.com/mwiki/index.php?search=std%3A%3A');
  });

  test('c: a search for the function, else the library', () => {
    assert.strictEqual(docsUrl({ libraryName: 'stdio.h', functionName: 'printf', language: 'c' }),
      'https://en.cppreference.com/mwiki/index.php?search=printf');
    assert.strictEqual(docsUrl({ libraryName: 'stdio.h', language: 'c' }),
      'https://en.cppreference.com/mwiki/index.php?search=stdio.h');
  });

  test('anything else: the npm package', () => {
    assert.strictEqual(docsUrl({ libraryName: 'lodash', language: 'typescript' }), 'https://www.npmjs.com/package/lodash');
    assert.strictEqual(docsUrl({ libraryName: 'lodash' }), 'https://www.npmjs.com/package/lodash');
  });

  test('a hostile library name stays on the fixed host', () => {
    const expected: Record<string, string> = {
      python: 'docs.python.org', java: 'javadoc.io', cpp: 'en.cppreference.com', c: 'en.cppreference.com', typescript: 'www.npmjs.com',
    };
    const names = ['//evil.example/x', '@evil.example', '../../../evil', '\\\\evil.example\\x', 'https://evil.example/', '#@evil.example', '?x=1'];
    for (const [language, host] of Object.entries(expected)) {
      for (const libraryName of names) {
        assert.strictEqual(new URL(docsUrl({ libraryName, language })).host, host, `${language} ${libraryName}`);
      }
    }
  });
});
