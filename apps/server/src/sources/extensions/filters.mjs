/** Runs inside the guest. Preserve maker objects/option values; only edit declared state. */
export function mangayomiFilters(filters, changes = []) {
  if (!Array.isArray(filters) || filters.length > 256 || !Array.isArray(changes) || changes.length > 512)
    throw new Error('invalid_source_filters');
  const definitions = [];
  function visit(filter, position, groupPosition) {
    const type = filter.type_name;
    const base = {
      id: `${position}:${groupPosition ?? ''}`,
      position,
      ...(groupPosition === undefined ? {} : { groupPosition }),
      label: String(filter.name ?? ''),
    };
    const options = () => (filter.values ?? []).map((value) => String(value?.name ?? value));
    if (type === 'GroupFilter') {
      if (groupPosition !== undefined || !Array.isArray(filter.state)) throw new Error('invalid_source_filters');
      definitions.push({ ...base, kind: 'header' });
      filter.state.forEach((child, index) => visit(child, position, index));
      return;
    }
    const kinds = {
      HeaderFilter: 'header',
      SeparatorFilter: 'separator',
      SelectFilter: 'select',
      SortFilter: 'sort',
      TextFilter: 'text',
      CheckBox: 'checkbox',
      CheckBoxFilter: 'checkbox',
      TriState: 'tri_state',
      TriStateFilter: 'tri_state',
    };
    const kind = kinds[type];
    if (!kind) throw new Error('compatibility_filter_unsupported');
    let value = filter.state;
    if (kind === 'checkbox') value = value ?? false;
    if (kind === 'text') value = value ?? '';
    if (kind === 'select') value = value ?? 0;
    if (kind === 'tri_state') value = ['IGNORE', 'INCLUDE', 'EXCLUDE'][value ?? 0];
    if (kind === 'sort') value = value ?? { index: 0, ascending: false };
    const definition = {
      ...base,
      kind,
      ...(['select', 'sort'].includes(kind) ? { options: options() } : {}),
      ...(['header', 'separator'].includes(kind) ? {} : { defaultValue: value }),
    };
    definitions.push(definition);
    const change = changes.find((change) => change.position === position && change.groupPosition === groupPosition);
    if (change) {
      value = change.value;
      const indexValid = (index) => Number.isInteger(index) && index >= 0 && index < definition.options.length;
      if (!(
        (kind === 'checkbox' && typeof value === 'boolean') ||
        (kind === 'text' && typeof value === 'string' && value.length <= 2000) ||
        (kind === 'select' && indexValid(value)) ||
        (kind === 'sort' && value && indexValid(value.index) && typeof value.ascending === 'boolean') ||
        (kind === 'tri_state' && ['IGNORE', 'INCLUDE', 'EXCLUDE'].includes(value))
      ))
        throw new Error('invalid_source_filters');
    }
    if (!['header', 'separator'].includes(kind))
      filter.state = kind === 'tri_state' ? ['IGNORE', 'INCLUDE', 'EXCLUDE'].indexOf(value) : value;
  }
  filters.forEach((filter, position) => visit(filter, position));
  if (
    definitions.length > 512 ||
    changes.some(
      (change) => !definitions.some((d) => d.position === change.position && d.groupPosition === change.groupPosition),
    )
  )
    throw new Error('invalid_source_filters');
  return definitions;
}
