function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isSecretKey(key) {
  return /(key|token|secret|password|sig|connectionstring|code)/i.test(String(key || ''));
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value === '') return '""';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderObjectAsTable(items, level, options) {
  const rows = items.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (rows.length === 0) {
    return `${'#'.repeat(level)} Data\n\nNo data\n\n`;
  }

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;

  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const raw = row[column];
      const value = options.maskSecrets && isSecretKey(column) ? '[REDACTED]' : formatValue(raw);
      return escapePipe(value);
    });
    return `| ${cells.join(' | ')} |`;
  });

  return `${header}\n${divider}\n${body.join('\n')}\n\n`;
}

function render(value, title, level, options) {
  const heading = `${'#'.repeat(level)} ${title}`;

  if (value === null || value === undefined) {
    return `${heading}\n\nNo data\n\n`;
  }

  if (isPrimitive(value)) {
    return `${heading}\n\n- ${formatValue(value)}\n\n`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${heading}\n\nNo items\n\n`;
    }

    const allPrimitive = value.every(isPrimitive);
    const allObjects = value.every((item) => item && typeof item === 'object' && !Array.isArray(item));

    if (allPrimitive) {
      const lines = value.map((item) => `- ${formatValue(item)}`).join('\n');
      return `${heading}\n\n${lines}\n\n`;
    }

    if (allObjects) {
      return `${heading}\n\n${renderObjectAsTable(value, level + 1, options)}`;
    }

    const mixed = value
      .map((item, index) => render(item, `Item ${index + 1}`, level + 1, options))
      .join('');
    return `${heading}\n\n${mixed}`;
  }

  const sections = Object.entries(value)
    .map(([key, childValue]) => {
      if (options.maskSecrets && isSecretKey(key)) {
        return `${'#'.repeat(level + 1)} ${key}\n\n- [REDACTED]\n\n`;
      }
      return render(childValue, key, level + 1, options);
    })
    .join('');

  return `${heading}\n\n${sections}`;
}

export function generateMarkdownFromJson(input, options = {}) {
  const { title = 'Report', maskSecrets = false } = options;
  return render(input, title, 1, { maskSecrets }).trim() + '\n';
}

export function downloadMarkdownFile(markdownContent, fileName = 'report.md') {
  const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}
