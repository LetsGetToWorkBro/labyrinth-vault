/**
 * The safe area, as a plain view.
 *
 * There are no insets in Node and no notch to be inside of. `SafeAreaView` is
 * the outermost element of every screen in this application, so it has to
 * render its children or the harness sees an empty tree; beyond that it adds
 * padding, and padding is layout, and layout is the half this harness has
 * always said it does not cover.
 */

import type { ReactElement } from 'react';

export const SafeAreaView = 'SafeAreaView' as unknown as (props: Record<string, unknown>) => ReactElement;
