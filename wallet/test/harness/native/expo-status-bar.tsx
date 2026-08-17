/** The system status bar. A host node so a screen's `<StatusBar style="light" />`
 *  renders, and so a test can read the style back rather than nothing at all. */

import type { ReactElement } from 'react';

export const StatusBar = 'StatusBar' as unknown as (props: Record<string, unknown>) => ReactElement;
