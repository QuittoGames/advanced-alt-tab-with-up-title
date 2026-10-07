/**
 * AATWS - Advanced Alt-Tab Window Switcher
 * SwitcherList
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2021-2025
 * @license    GPL-3.0
 */

'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';
import { AppIcon, WindowIcon, SysActionIcon, ShowAppsIcon } from './switcherItems.js';

// gettext
let _;

// Gaps between the reflowing items. The column gap comes from the stylesheet
// (`spacing` on .switcher-list-item-container, inherited from the active theme),
// so the horizontal look stays identical to the old single line layout; the row
// gap never gets thinner than FLOW_ROW_SPACING so wrapped rows stay readable.
const FALLBACK_COLUMN_SPACING = 1;
const FLOW_ROW_SPACING = 8;


/* Item structure:
   Window: (WindowIcon)icon.window
                           .app
                           .titleLabel
                           ._isWindow
                           ._icon
                           ._id
                           ._closeButton


   App:    (AppIcon)icon.app
                        .titleLabel
                        .cachedWindows
                        ._appDetails
                        ._isApp
                        .icon
                        ._id

*/

export function init(me) {
    _ = me._;
}

export function cleanGlobal() {
    _ = null;
}

export const SwitcherList = GObject.registerClass({
    GTypeName: `SwitcherList${Math.floor(Math.random() * 1000)}`,
}, class SwitcherList extends SwitcherPopup.SwitcherList {
    _init(items, opt, wsp) {
        super._init(false); // squareItems = false

        // AATWS: the items are reflowed onto as many rows as needed to fit
        // the available width (Windows 11 style) instead of staying on a single
        // horizontal line. The flow container is a *child* of this._list rather
        // than its layout manager: StBoxLayout casts its layout manager to
        // ClutterBoxLayout from its style_changed handler, so replacing it would
        // spam the shell journal with invalid cast warnings.
        this._flowContainer = new St.Widget({
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_spacing: FALLBACK_COLUMN_SPACING,
                row_spacing: FLOW_ROW_SPACING,
                // greedy wrap: a row is broken as soon as the next item no
                // longer fits, so the columns per row depend on the width
                snap_to_grid: false,
            }),
        });
        this._list.add_child(this._flowContainer);

        // The horizontal gap used to be applied by StBoxLayout itself: it reads
        // `spacing` from .switcher-list-item-container and pushes it into its
        // ClutterBoxLayout. Now that the items are children of the flow
        // container that CSS value no longer reaches them, so read it back and
        // hand it to the FlowLayout - this keeps whatever the active theme
        // wins in the cascade, exactly like before the reflow.
        this._list.connect('style-changed', () => this._updateFlowSpacing());

        // Every item stays visible after the reflow, so there is nothing left
        // to scroll horizontally - keep the base class arrows hidden.
        this._scrollableLeft = false;
        this._scrollableRight = false;
        this._maxContentWidth = 0;
        this._contentWidth = 0;

        this._opt = opt;
        this._switcherParams = this._getSwitcherParams(opt, wsp);
        this._wsp = wsp;

        this._addStatusLabel();

        this.icons = [];

        let showAppsIcon;
        let showAppsItemBox;
        const dashMode = this._switcherParams.dashMode;
        if (!items[0].get_title && (!dashMode && this._opt.INCLUDE_SHOW_APPS_ICON || (dashMode && opt.DASH_APP_INCLUDE_APPS_ICON))) {
            showAppsIcon = this._getShowAppsIcon();
            if (this._switcherParams.reverseOrder) {
                showAppsItemBox = this.addItem(showAppsIcon, showAppsIcon.titleLabel);
                this.icons.push(showAppsIcon);
            }
        }

        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            let icon;
            if (item.get_title) {
                icon = new WindowIcon(item, i, this._switcherParams, this._opt);
            } else if (item.get_app_info) {
                icon = new AppIcon(item, i, this._switcherParams, this._opt);
                icon.connect('menu-state-changed',
                    (o, open) => {
                        this._opt.cancelTimeout = open;
                    }
                );
            } else {
                icon = new SysActionIcon(item, i, this._switcherParams, this._opt);
            }

            this.icons.push(icon);

            // compensate item height added by "running dot (line)" indicator
            const listItem = this.addItem(icon, icon.titleLabel);
            // In GS 46 the item bg become solid color and highlighting is made by altering the base color
            if (!this._opt.COLOR_STYLE_DEFAULT)
                listItem.add_style_class_name('item-box-custom');
            if (icon._isApp && (this._switcherParams.includeFavorites || this._switcherParams.searchActive)) {
                const margin = 1;
                listItem.set_style(`padding-bottom: ${margin}px;`);
            }

            // the icon could be an app, not only a window
            if (icon._isWindow) {
                icon.window.connectObject('unmanaged', this._removeWindow.bind(this), this);
            } else if (icon._isApp) {
                if (icon.app.cachedWindows.length > 0) {
                    icon.app.cachedWindows.forEach(w => {
                        w.connectObject('unmanaged', this._removeWindow.bind(this), this);
                    });
                }
            }
        }

        if (showAppsIcon && !this._switcherParams.reverseOrder) {
            showAppsItemBox = this.addItem(showAppsIcon, showAppsIcon.titleLabel);
            this.icons.push(showAppsIcon);
        }

        if (!this._opt.COLOR_STYLE_DEFAULT && showAppsItemBox)
            showAppsItemBox.add_style_class_name('item-box-custom');

        this.connect('destroy', this._onDestroy.bind(this));
    }

    addItem(item, label) {
        const itemBox = super.addItem(item, label);

        // The base class parents the item to this._list (its single line box
        // container); move it into the wrapping container instead so that it
        // takes part in the row reflow. All bookkeeping done by the base class
        // (signals, _items, label_actor) is left untouched.
        this._list.remove_child(itemBox);
        this._flowContainer.add_child(itemBox);

        return itemBox;
    }

    /**
     * Item indices grouped by visual row, derived from the allocations the flow
     * layout actually produced. Deriving the rows from the real geometry keeps
     * a second copy of the wrapping rule from drifting away from the layout.
     *
     * @returns {number[][]} indices of the items of each row
     */
    getRows() {
        const rows = [];
        let rowY = null;

        for (let i = 0; i < this._items.length; i++) {
            // items of the same row are all allocated at the same y position
            const y = Math.round(this._items[i].allocation.y1);
            if (rowY === null || Math.abs(y - rowY) > 1)
                rows.push([]);

            rowY = y;
            rows[rows.length - 1].push(i);
        }

        return rows;
    }

    _addStatusLabel() {
        if (!this._opt.STATUS)
            return;

        this._statusLabel = new St.Label({
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'status-label',
        });

        this.add_child(this._statusLabel);
    }

    _getSwitcherParams(opt, wsp) {
        let showWinTitles = opt.WINDOW_TITLES === 1 || (opt.WINDOW_TITLES === 3 && wsp._singleApp);
        return {
            dashMode: wsp._dashMode,
            mouseControl: !wsp._keyboardTriggered,
            showingApps: wsp._showingApps,
            showItemTitle: wsp._showingApps ? opt.SHOW_APP_TITLES : showWinTitles,
            showWinTitles,
            winPrevSize: wsp._singleApp ? opt.SINGLE_APP_PREVIEW_SIZE : opt.WINDOW_PREVIEW_SIZE,
            hotKeys: opt.HOT_KEYS && wsp._keyboardTriggered,
            singleApp: wsp._singleApp,
            addAppDetails: !!wsp._searchQuery,
            includeFavorites: wsp._includeFavorites,
            searchActive: !!wsp._searchQuery,
            reverseOrder: wsp._shouldReverse(),
        };
    }

    _getShowAppsIcon() {
        const showAppsIcon = new ShowAppsIcon({
            iconSize: this._opt.APP_MODE_ICON_SIZE,
            showLabel: this._opt.SHOW_APP_TITLES,
            style: this._opt.colorStyle.TITLE_LABEL,
        });

        showAppsIcon.connect('button-press-event', (a, event) => {
            const btn = event.get_button();
            if (btn === Clutter.BUTTON_SECONDARY) {
                Main.overview.toggle();
                return Clutter.EVENT_STOP;
            } else if (btn === Clutter.BUTTON_MIDDLE) {
                this._wsp._openPrefsWindow();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return showAppsIcon;
    }

    _onDestroy() {
        this.icons.forEach(icon => {
            if (icon.app?.cachedWindows) {
                icon.app.cachedWindows.forEach(w => {
                    w.disconnectObject(this);
                });
            } else {
                icon.window?.disconnectObject(this);
            }
        });
    }

    /**
     * Gaps of the reflowing rows.
     *
     * StBoxLayout reads the CSS `spacing` of .switcher-list-item-container and
     * pushes it into its own ClutterBoxLayout, so before the reflow the
     * horizontal gap always came from whatever stylesheet won the cascade.
     * The items are now children of the flow container and no longer see that
     * property, so read it back from the theme node and apply it here - the
     * horizontal rhythm stays exactly what the stylesheet asks for, and the row
     * gap never gets thinner than FLOW_ROW_SPACING.
     */
    _updateFlowSpacing() {
        const columnSpacing = this._list.get_theme_node().get_length('spacing') || FALLBACK_COLUMN_SPACING;
        const rowSpacing = Math.max(columnSpacing, FLOW_ROW_SPACING);

        const layout = this._flowContainer.get_layout_manager();
        if (layout.column_spacing === columnSpacing && layout.row_spacing === rowSpacing)
            return;

        layout.column_spacing = columnSpacing;
        layout.row_spacing = rowSpacing;
    }

    /**
     * Width of the area the items are reflowed into, i.e. the width requested
     * by the caller minus this widget's own border and padding.
     *
     * @param {number} forWidth - width requested by the caller
     * @returns {number} available content width, or -1 when it is unknown
     */
    _getContentWidth(forWidth) {
        if (!(forWidth > 0))
            return -1;

        const themeNode = this.get_theme_node();
        const box = new Clutter.ActorBox();
        box.x1 = 0;
        box.y1 = 0;
        box.x2 = forWidth;
        box.y2 = 0;
        const contentBox = themeNode.get_content_box(box);

        return contentBox.x2 - contentBox.x1;
    }

    /**
     * Width of the widest row produced by reflowing the items into `wrapWidth`.
     *
     * Clutter.FlowLayout never reports a wrapped width: for a horizontal flow
     * get_preferred_width() is not given an available width, so it always
     * returns the single line total as its natural width. The panel therefore
     * has to replay the same packing rule Clutter uses in allocate()
     * (`item_x + child_natural > avail_width` starts a new row) to know how
     * wide it really has to be.
     *
     * @param {number} wrapWidth - width the items are reflowed into
     * @returns {number} width of the widest row, 0 when there is nothing to pack
     */
    _getWidestRowWidth(wrapWidth) {
        if (!(wrapWidth > 0))
            return 0;

        const spacing = this._flowContainer.get_layout_manager().column_spacing || 0;
        let x = 0;
        let widest = 0;

        for (const child of this._flowContainer.get_children()) {
            if (!child.visible)
                continue;

            const [, naturalWidth] = child.get_preferred_width(-1);
            if (x + naturalWidth > wrapWidth) {
                widest = Math.max(widest, x - spacing);
                x = 0;
            }
            x += naturalWidth + spacing;
        }

        return Math.max(0, widest, x - spacing);
    }

    vfunc_get_preferred_height(forWidth) {
        // The popup passes the monitor width, so the items are reflowed for the
        // space that is really available. The height therefore depends on how
        // many rows the layout produces for that width: one row stays small, the
        // rows that follow make the popup grow vertically.
        // The style is computed by now, so the theme's spacing can be applied
        // before the rows are measured for the available width.
        this._updateFlowSpacing();

        const availableWidth = this._getContentWidth(forWidth);
        if (availableWidth > 0)
            this._maxContentWidth = availableWidth;

        // The items only wrap up to the available width, but the panel itself
        // must end where the widest row ends - otherwise a wrapped list would
        // stretch the popup across the whole monitor.
        let contentWidth = this._maxContentWidth;
        if (contentWidth > 0)
            contentWidth = this._getWidestRowWidth(contentWidth) || contentWidth;
        this._contentWidth = contentWidth;

        // FlowLayout returns the height of the tallest row as its minimum and
        // the height of all rows as its natural height. The width measured here
        // and the width the popup allocates later are the same value, so
        // Clutter keeps the row count it was measured with: if they diverge,
        // allocate() rewraps and the rows no longer fit the height reported
        // here.
        const [rowsMin, rowsNat] = this._flowContainer.get_preferred_height(contentWidth);
        console.error(`[AATWS-DBG] height forWidth=${forWidth} avail=${availableWidth} content=${contentWidth} rows=[${rowsMin},${rowsNat}]`);

        const themeNode = this.get_theme_node();
        let [minHeight, natHeight] = themeNode.adjust_preferred_height(rowsMin, rowsNat);

        const spacing = themeNode.get_padding(St.Side.BOTTOM);
        let labelMin = 0;
        let labelNat = 0;
        if (this._statusLabel)
            [labelMin, labelNat] = this._statusLabel.get_preferred_height(-1);

        minHeight += labelMin + spacing;
        natHeight += labelNat + spacing;

        return [minHeight, natHeight];
    }

    vfunc_get_preferred_width(forHeight) {
        const [minLineWidth, oneLineWidth] = this._list.get_preferred_width(forHeight);

        // After the reflow the popup only needs the width of the widest row. If
        // the rows have not been measured for an available width yet, fall back
        // to the single line width, which is what the base class reports.
        let contentWidth = oneLineWidth;
        const panelWidth = this._contentWidth > 0 ? this._contentWidth : this._maxContentWidth;
        if (panelWidth > 0)
            contentWidth = Math.min(contentWidth, panelWidth);
        contentWidth = Math.max(contentWidth, minLineWidth);
        console.error(`[AATWS-DBG] width forHeight=${forHeight} minLine=${minLineWidth} oneLine=${oneLineWidth} avail=${this._maxContentWidth} content=${this._contentWidth} -> ${contentWidth}`);

        return this.get_theme_node().adjust_preferred_width(minLineWidth, contentWidth);
    }

    vfunc_allocate(box) {
        let themeNode = this.get_theme_node();
        let contentBox = themeNode.get_content_box(box);
        const spacing = themeNode.get_padding(St.Side.BOTTOM);
        const statusLabelHeight = this._statusLabel ? this._statusLabel.height : spacing;
        const totalLabelHeight = statusLabelHeight;

        box.y2 -= totalLabelHeight;
        super.vfunc_allocate(box);

        // Hooking up the parent vfunc will call this.set_allocation() with
        // the height without the label height, so call it again with the
        // correct size here.
        box.y2 += totalLabelHeight;


        this.set_allocation(box);

        if (this._statusLabel) {
            const childBox = new Clutter.ActorBox();
            childBox.x1 = contentBox.x1 + 5;
            childBox.x2 = contentBox.x2;
            childBox.y2 = contentBox.y2;
            childBox.y1 = childBox.y2 - statusLabelHeight;
            this._statusLabel.allocate(childBox);
        }
    }

    _onItemMotion(item) {
        // Avoid reentrancy
        const icon = this.icons[this._items.indexOf(item)];
        if (item !== this._items[this._highlighted] || (this._opt.INTERACTIVE_INDICATORS && !icon._mouseControlsSet))
            this._itemEntered(this._items.indexOf(item));

        return Clutter.EVENT_PROPAGATE;
    }

    _onItemEnter(item) {
        // Avoid reentrance
        // if (item !== this._items[this._highlighted])
        this._itemEntered(this._items.indexOf(item));

        return Clutter.EVENT_PROPAGATE;
    }

    highlight(index) {
        const prevIcon = this.icons[this._highlighted];
        if (prevIcon?._closeButton)
            prevIcon._closeButton.opacity = 0;

        if (this._items[this._highlighted]) {
            this._items[this._highlighted].remove_style_pseudo_class('selected');
            if (this._opt.colorStyle.STYLE)
                this._items[this._highlighted].remove_style_class_name(this._opt.colorStyle.SELECTED);
        }

        const icon = this.icons[index];
        if (this._items[index]) {
            this._items[index].add_style_pseudo_class('selected');
            if (this._opt.colorStyle.STYLE) {
                // this._items[index].remove_style_class_name(this._opt.colorStyle.FOCUSED);
                this._items[index].add_style_class_name(this._opt.colorStyle.SELECTED);
            }
        }

        this._highlighted = index;

        // Close button follows the highlighted card for keyboard navigation too.
        // _updateMouseControls() only runs while the pointer drives the switcher,
        // so without this branch the button never appears on a plain Alt+Tab.
        if (icon?.window) {
            if (!icon._closeButton) {
                icon._createCloseButton(icon.window);
                icon._closeButton.connect('enter-event', () => {
                    icon._closeButton.add_style_class_name('window-close-hover');
                });
                icon._closeButton.connect('leave-event', () => {
                    icon._closeButton.remove_style_class_name('window-close-hover');
                });
            }
            icon._closeButton.opacity = 255;
        }

        const dbgItem = this._items[index];
        if (dbgItem) {
            const dbgNode = dbgItem.get_theme_node();
            const dbgBg = dbgNode.get_background_color();
            // pad=8 => Fluent's ".switcher-list .item-box { padding: 8px }" matches
            // (item really carries `item-box` under `.switcher-list`); rad=10 => this
            // extension's stylesheet is loaded, rad=5 => only the theme's rule matched.
            let dbgPad = -1;
            let dbgRad = -1;
            try { dbgPad = dbgNode.get_length('padding-top'); } catch (e) { dbgPad = -2; }
            try { dbgRad = dbgNode.get_length('border-radius'); } catch (e) { dbgRad = -2; }
            logError(new Error(`[AATWS-DBG] highlight idx=${index} cls="${dbgItem.style_class}" box=${dbgItem.width}x${dbgItem.height}@${dbgItem.x},${dbgItem.y} parent=${dbgItem.get_parent()?.get_name?.() || dbgItem.get_parent()?.constructor?.name} bg=rgba(${dbgBg.red},${dbgBg.green},${dbgBg.blue},${(dbgBg.alpha / 255).toFixed(2)}) pad=${dbgPad} rad=${dbgRad}`));
        }

        // No horizontal scrolling: the items are wrapped into the popup width,
        // so the highlighted item is always visible already.
    }

    // The base class scrolls its single line container to the selected item.
    // With wrapping there is no horizontal overflow left, so these are no-ops -
    // they only keep _initialSelection() and the base class arrow flags working.
    _scrollToLeft() {
    }

    _scrollToRight() {
    }

    _removeWindow(window) {
        if (this.icons[0].window) {
            let index = this.icons.findIndex(icon =>
                icon.window === window
            );
            if (index === -1)
                return;

            this.icons.splice(index, 1);
            this.removeItem(index);
        } else {
            this.emit('item-removed', -1);
        }
    }

    // //////////////////////////////////////////////////////////

    _updateMouseControls(selectedIndex) {
        if (!this._wsp.mouseActive || !this._wsp._timeoutIds) // timeoutIds are missing if the popup belongs to the Tiling assistant
            return;

        // activate indicators only when mouse pointer is (probably) used to control the switcher
        if (this._updateNeeded) {
            this.icons.forEach(w => {
                if (w._closeButton)
                    w._closeButton.opacity = 0;

                if (w._aboveStickyIndicatorBox)
                    w._aboveStickyIndicatorBox.opacity = 0;

                if (w._hotkeyIndicator)
                    w._hotkeyIndicator.opacity = 255;
            });
        }

        if (selectedIndex === undefined)
            return;

        const item = this.icons[selectedIndex];
        if (!item)
            return;

        // workaround - only the second call of _isPointerOut() returns correct answer
        // this._wsp._isPointerOut();
        if (item.window /* && !this._wsp._isPointerOut() */) {
            if (!item._closeButton) {
                item._createCloseButton(item.window);
                this._updateNeeded = true;
                item._closeButton.connect('enter-event', () => {
                    item._closeButton.add_style_class_name('window-close-hover');
                });
                item._closeButton.connect('leave-event', () => {
                    item._closeButton.remove_style_class_name('window-close-hover');
                });
            }
            item._closeButton.opacity = 255;
        }

        if (!this._opt.INTERACTIVE_INDICATORS/* || this._wsp._isPointerOut()*/)
            return;

        if (item.window && !item._aboveStickyIndicatorBox) {
            item._aboveStickyIndicatorBox = item._getIndicatorBox();
            item._icon.add_child(item._aboveStickyIndicatorBox);
        }

        if (item._aboveStickyIndicatorBox) {
            item._aboveStickyIndicatorBox.opacity = 255;
            if  (item._hotkeyIndicator)
                item._hotkeyIndicator.opacity = 0;
        }

        if (item._aboveIcon && !item._aboveIcon.reactive) {
            item._aboveIcon.reactive = true;
            item._aboveIcon.opacity = 255;
            const canAbove =
                !((item.window.get_maximized && item.window.get_maximized() === Meta.MaximizeFlags.BOTH) || // GNOME <= 48
                (item.window.is_maximized && item.window.is_maximized())); // Since GNOME 49

            item._aboveIcon.connect('button-press-event', () => {
                if (canAbove)
                    this._wsp._toggleWinAbove();
                return Clutter.EVENT_STOP;
            });

            if (canAbove) {
                item._aboveIcon.connect('enter-event', () => {
                    item._aboveIcon.add_style_class_name('window-state-indicators-hover');
                });
                item._aboveIcon.connect('leave-event', () => {
                    item._aboveIcon.remove_style_class_name('window-state-indicators-hover');
                });
            }
        }

        if (item._stickyIcon && !item._stickyIcon.reactive) {
            item._stickyIcon.reactive = true;
            item._stickyIcon.opacity = 255;
            item._stickyIcon.connect('button-press-event', () => {
                this._wsp._toggleWinSticky();
                return Clutter.EVENT_STOP;
            });
            item._stickyIcon.connect('enter-event', () => {
                item._stickyIcon.add_style_class_name('window-state-indicators-hover');
            });
            item._stickyIcon.connect('leave-event', () => {
                item._stickyIcon.remove_style_class_name('window-state-indicators-hover');
            });
        }

        if (item.window && !item._menuIcon) {
            item._menuIcon = new St.Icon({
                style_class: 'window-state-indicators',
                icon_name: 'view-more-symbolic',
                icon_size: 14,
                y_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            item._menuIcon.add_style_class_name(this._opt.colorStyle.INDICATOR_OVERLAY);
            item._aboveStickyIndicatorBox.add_child(item._menuIcon);
            item._menuIcon.reactive = true;
            item._menuIcon.opacity = 255;
            item._menuIcon.connect('button-press-event', () => {
                this._wsp._openWindowMenu();
                return Clutter.EVENT_STOP;
            });
            item._menuIcon.connect('enter-event', () => {
                item._menuIcon.add_style_class_name('window-state-indicators-hover');
            });
            item._menuIcon.connect('leave-event', () => {
                item._menuIcon.remove_style_class_name('window-state-indicators-hover');
            });
        }

        if (item._appIcon && !item._appIcon.reactive) {
            item._appIcon.reactive = true;
            item._appIcon.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === Clutter.BUTTON_PRIMARY) {
                    this._wsp._toggleSingleAppMode();
                    return Clutter.EVENT_STOP;
                } else if (button === Clutter.BUTTON_MIDDLE) {
                    this._wsp._openNewWindow();
                    return Clutter.EVENT_STOP;
                } else if (button === Clutter.BUTTON_SECONDARY) {
                    this._wsp._toggleSwitcherMode();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            item._appIcon.connect('enter-event', () => {
                item._appIcon.add_style_class_name(this._opt.colorStyle.INDICATOR_OVERLAY_HOVER);
            });
            item._appIcon.connect('leave-event', () => {
                item._appIcon.remove_style_class_name(this._opt.colorStyle.INDICATOR_OVERLAY_HOVER);
            });
        }

        if (item._wsIndicator && !item._wsIndicator.reactive) {
            const cws = global.workspaceManager.get_active_workspace();
            const ws = item.window.get_workspace();

            item._wsIndicator.reactive = true;
            item._wsIndicator.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === Clutter.BUTTON_PRIMARY) {
                    if (this._wsp._getSelectedTarget().get_workspace().index() !== global.workspaceManager.get_active_workspace_index())
                        this._wsp._actions.moveToCurrentWS();
                    return Clutter.EVENT_STOP;
                } else if (button === Clutter.BUTTON_MIDDLE) {
                    return Clutter.EVENT_PROPAGATE;
                } else if (button === Clutter.BUTTON_SECONDARY) {
                    if (ws === cws)
                        Main.overview.toggle();
                    else
                        Main.wm.actionMoveWorkspace(ws);

                    /* this._wsp._filterSwitched = true;
                    this._wsp._winFilterMode = FilterMode.WORKSPACE;
                    this._wsp._updateSwitcher();*/
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            if (ws === cws)
                return;

            item._wsIndicator.connect('enter-event', () => {
                const ws = global.workspaceManager.get_active_workspace_index() + 1;
                const winWs = item.window.get_workspace().index() + 1;
                const monitor = item.window.get_monitor();
                const currentMonitor = global.display.get_current_monitor();
                const multiMonitor = global.display.get_n_monitors() - 1;
                item._wsIndicator.text = `${winWs}${multiMonitor ? `.${monitor.toString()}` : ''} → ${ws}${multiMonitor ? `.${currentMonitor.toString()}` : ''}`;
                // item._wsIndicator.add_style_class_name('ws-indicator-hover');
            });
            item._wsIndicator.connect('leave-event', () => {
                // item._wsIndicator.remove_style_class_name('ws-indicator-hover');
                item._wsIndicator.text = (item.window.get_workspace().index() + 1).toString();
            });
        }

        if (item._winCounterIndicator && !item._winCounterIndicator.reactive) {
            item._winCounterIndicator.reactive = true;
            item._winCounterIndicator.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === Clutter.BUTTON_PRIMARY) {
                    this._wsp._toggleSingleAppMode();
                    return Clutter.EVENT_STOP;
                } else if (button === Clutter.BUTTON_MIDDLE) {
                    return Clutter.EVENT_PROPAGATE;
                } else if (button === Clutter.BUTTON_SECONDARY) {
                    // inactive
                }
                return Clutter.EVENT_PROPAGATE;
            });

            item._winCounterIndicator.connect('enter-event', () => {
                item._winCounterIndicator.add_style_class_name(this._opt.colorStyle.RUNNING_COUNTER_HOVER);
            });
            item._winCounterIndicator.connect('leave-event', () => {
                item._winCounterIndicator.remove_style_class_name(this._opt.colorStyle.RUNNING_COUNTER_HOVER);
            });
        }

        item._mouseControlsSet = true;
        this._wsp._mouseHoveringItemIndex = selectedIndex;
    }
});
