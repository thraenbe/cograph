// docsUrl.ts — the documentation page of a library. Pure, so the extension host opens it and the
// static viewer's bridge carries the same function (scripts/build-stage.js). Every branch has a fixed
// host and a path before the library name, so no name, hostile or not, can change where it leads.

export interface DocsTarget {
  libraryName: string;
  language?: string;
  functionName?: string;
}

export function docsUrl({ libraryName, language, functionName }: DocsTarget): string {
  if (language === 'python') {
    return `https://docs.python.org/3/library/${libraryName.split('.')[0]}`;
  }
  if (language === 'java') {
    if (libraryName.startsWith('java.') || libraryName.startsWith('javax.')) {
      const pkgPath = libraryName.replace(/\./g, '/');
      return `https://docs.oracle.com/en/java/javase/21/docs/api/java.base/${pkgPath}/package-summary.html`;
    }
    return `https://javadoc.io/doc/${libraryName}`;
  }
  if (language === 'cpp') {
    const q = encodeURIComponent(`${libraryName}::${functionName ?? ''}`);
    return `https://en.cppreference.com/mwiki/index.php?search=${q}`;
  }
  if (language === 'c') {
    return `https://en.cppreference.com/mwiki/index.php?search=${encodeURIComponent(functionName ?? libraryName)}`;
  }
  return `https://www.npmjs.com/package/${libraryName}`;
}
