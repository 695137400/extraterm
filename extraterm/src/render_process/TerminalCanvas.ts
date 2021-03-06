/*
 * Copyright 2019 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import {Logger, getLogger} from "extraterm-logging";

import * as DisposableUtils from '../utils/DisposableUtils';
import * as ResizeRefreshElementBase from './ResizeRefreshElementBase';
import { ScrollBar } from "./gui/ScrollBar";
import { VirtualScrollAreaWithSpacing, Spacer } from "./VirtualScrollAreaWithSpacing";
import { EVENT_RESIZE, VirtualScrollable } from "./VirtualScrollArea";
import { ViewerElement } from "./viewers/ViewerElement";
import { TerminalViewer } from "./viewers/TerminalAceViewer";
import { Disposable } from "extraterm-extension-api";
import { AcceptsConfigDatabase, ConfigDatabase, GENERAL_CONFIG, GeneralConfig, ConfigChangeEvent } from "../Config";
import { doLater } from "../utils/DoLater";
import * as DomUtils from './DomUtils';
import { EmbeddedViewer } from "./viewers/EmbeddedViewer";
import { TextViewer } from "./viewers/TextAceViewer";
import { VisualState, Mode, CursorEdgeDetail, Edge } from "./viewers/ViewerElementTypes";
import { EventEmitter } from "../utils/EventEmitter";
import { Event } from 'extraterm-extension-api';


const SCROLL_STEP = 1;
const CHILD_RESIZE_BATCH_SIZE = 3;


interface ChildElementStatus {
  element: VirtualScrollable & HTMLElement;
  needsRefresh: boolean;
  refreshLevel: ResizeRefreshElementBase.RefreshLevel;
}


export class TerminalCanvas implements AcceptsConfigDatabase {
  private _log: Logger;
  private _configDatabase: ConfigDatabase = null;
  private _virtualScrollArea: VirtualScrollAreaWithSpacing = null;
  private _stashArea: DocumentFragment = null;
  private _childElementList: ChildElementStatus[] = [];
  private _needsCompleteRefresh = true;
  private _scheduleLaterHandle: Disposable = null;
  private _scheduleLaterQueue: Function[] = [];
  private _stashedChildResizeTask: () => void = null;

  // This flag is needed to prevent the _enforceScrollbackLength() method from being run recursively
  private _enforceScrollbackLengthGuard= false;
  private _childFocusHandlerFunc: (ev: FocusEvent) => void;
  private _mode: Mode = Mode.DEFAULT;
  private _elementAttached = false;

  private _terminalViewer: TerminalViewer = null; // FIXME rename to 'focusTarget'?

  private _onBeforeSelectionChangeEmitter = new EventEmitter<{sourceMouse: boolean}>();
  onBeforeSelectionChange: Event<{sourceMouse: boolean}>;

  constructor(private _scrollContainer: HTMLDivElement, private _scrollArea: HTMLDivElement,
      private _scrollBar: ScrollBar) {

    this._log = getLogger("TerminalCanvas", this);
    this.onBeforeSelectionChange = this._onBeforeSelectionChangeEmitter.event;
    this._childFocusHandlerFunc = this._handleChildFocus.bind(this);

    this._stashArea = window.document.createDocumentFragment();
    this._stashArea.addEventListener(EVENT_RESIZE, this._handleVirtualScrollableResize.bind(this));

    this._virtualScrollArea = new VirtualScrollAreaWithSpacing(0);
    this._virtualScrollArea.setScrollFunction( (offset: number): void => {
      this._scrollArea.style.top = "-" + offset + "px";
    });
    this._virtualScrollArea.setScrollbar(this._scrollBar);
    this._virtualScrollArea.setSetTopFunction((vsa, top) => this._setTopFunction(vsa,top));
    this._virtualScrollArea.setMarkVisibleFunction(
      (virtualScrollable: VirtualScrollable, visible:boolean) => this._markVisible(virtualScrollable, visible));

    this._scrollArea.addEventListener('mousedown', (ev: MouseEvent): void => {
      if (ev.target === this._scrollArea) {
        this._terminalViewer.focus();
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    
    this._scrollBar.addEventListener('scroll', (ev: CustomEvent) => {
      this._virtualScrollArea.scrollTo(this._scrollBar.getPosition());
    });

    this._scrollArea.addEventListener('wheel', this._handleMouseWheel.bind(this), true);


    this._scrollArea.addEventListener(EVENT_RESIZE, this._handleVirtualScrollableResize.bind(this));
    this._scrollArea.addEventListener(TerminalViewer.EVENT_KEYBOARD_ACTIVITY, () => {
      this._virtualScrollArea.scrollToBottom();
    });
    this._scrollArea.addEventListener(ViewerElement.EVENT_BEFORE_SELECTION_CHANGE,
      this._handleBeforeSelectionChange.bind(this));
    this._scrollArea.addEventListener(ViewerElement.EVENT_CURSOR_MOVE, this._handleViewerCursor.bind(this));
    this._scrollArea.addEventListener(ViewerElement.EVENT_CURSOR_EDGE, this._handleViewerCursorEdge.bind(this));
    
    this._scheduleResize();
  }

  private _handleChildFocus(ev: FocusEvent): void {
    // This needs to be done later otherwise it tickles a bug in
    // Chrome/Blink and prevents drag and drop from working.
    // https://bugs.chromium.org/p/chromium/issues/detail?id=726248
    doLater( () => {
      if (this._mode === Mode.DEFAULT) {
        this.focus();
      }
    });
  }

  private _handleBeforeSelectionChange(ev: CustomEvent): void {
    const target = ev.target;
    this._childElementList.forEach( (nodeInfo): void => {
      const node = nodeInfo.element;
      if (ViewerElement.isViewerElement(node) && node !== target) {
        node.clearSelection();
      }
    });

    this._onBeforeSelectionChangeEmitter.fire({ sourceMouse: ev.detail.originMouse });
  }

  dispose(): void {
    for (const kid of this._childElementList) {
      if (DisposableUtils.isDisposable(kid.element)) {
        kid.element.dispose();
      }
    }
  }

  connectedCallback(): void {
    this._updateScrollableSpacing();
    this._elementAttached = true;
  }

  disconnectedCallback(): void {
    this._needsCompleteRefresh = true;
    this._elementAttached = false;
  }

  setConfigDatabase(configManager: ConfigDatabase): void {
    this._configDatabase = configManager;
    this._configDatabase.onChange((event: ConfigChangeEvent) => {
      if (event.key === "general") {
        const oldConfig = <GeneralConfig> event.oldConfig;
        const newConfig = <GeneralConfig> event.newConfig;
        if (oldConfig.uiScalePercent !== newConfig.uiScalePercent ||
            oldConfig.terminalMarginStyle !== newConfig.terminalMarginStyle) {
          if (this._elementAttached) {
            this._updateScrollableSpacing();
            this.refresh(ResizeRefreshElementBase.RefreshLevel.COMPLETE);
          }
        }
      }
    });
  }

  private _updateScrollableSpacing(): void {
    const generalConfig = this._configDatabase.getConfig("general");
    let spacing = 0;
    switch (generalConfig.terminalMarginStyle) {
      case "none":
        spacing = 0;
        break;
      case "thin":
        spacing = Math.round(this._rootFontSize()/2);
        break;
      case "normal":
        spacing = this._rootFontSize();
        break;
      case "thick":
        spacing = this._rootFontSize() * 2;
        break;            
    }
    this._virtualScrollArea.setSpacing(spacing);
  }

  private _rootFontSize(): number {
    const generalConfig = this._configDatabase.getConfig("general");
    const systemConfig = this._configDatabase.getConfig("system");
    
    const dpiScaleFactor = systemConfig.originalScaleFactor / systemConfig.currentScaleFactor;
    const unitHeightPx = 12;

    const rootFontSize = Math.max(Math.floor(unitHeightPx * generalConfig.uiScalePercent * dpiScaleFactor / 100), 5);
    return rootFontSize;
  }

  setModeAndVisualState(mode: Mode, visualState: VisualState): void {
    for (const element of this.getChildElements()) {
      if (ViewerElement.isViewerElement(element)) {
        element.setMode(mode);
        element.setVisualState(visualState);
      }
    }
  }

  setTerminalViewer(terminalViewer: TerminalViewer): void {
    this._terminalViewer = terminalViewer;
  }

  focus(): void {
    if (this._terminalViewer !== null) {
      DomUtils.focusWithoutScroll(this._terminalViewer);
    }
  }

  appendScrollable(el: HTMLElement & VirtualScrollable): void {
    el.addEventListener('focus', this._childFocusHandlerFunc);
    
    this._childElementList.push( { element: el, needsRefresh: false, refreshLevel: ResizeRefreshElementBase.RefreshLevel.RESIZE } );
    this._scrollArea.appendChild(el);
    this._virtualScrollArea.appendScrollable(el);
  }

  removeScrollable(el: HTMLElement & VirtualScrollable): void {
    el.removeEventListener('focus', this._childFocusHandlerFunc);

    if (el.parentElement === this._scrollArea) {
      this._scrollArea.removeChild(el);
    } else if(el.parentNode === this._stashArea) {
      this._stashArea.removeChild(el);
    }

    const pos = this._childElementListIndexOf(el);
    this._childElementList.splice(pos, 1);

    this._virtualScrollArea.removeScrollable(el);
  }

  private _childElementListIndexOf(element: HTMLElement & VirtualScrollable): number {
    const list = this._childElementList;;
    const len = list.length;
    for (let i=0; i<len; i++) {
      const item = list[i];
      if (item.element === element) {
        return i;
      }
    }
    return -1;
  }

  updateScrollableSize(scrollable: VirtualScrollable): void {
    this._virtualScrollArea.updateScrollableSize(scrollable);
  }

  private _handleMouseWheel(ev: WheelEvent): void {
    ev.stopPropagation();
    ev.preventDefault();
    const delta = ev.deltaY * SCROLL_STEP;
    this._virtualScrollArea.scrollTo(this._virtualScrollArea.getScrollYOffset() + delta);
  }

  private _handleVirtualScrollableResize(ev: CustomEvent): void {
    const el = <HTMLElement & VirtualScrollable> ev.target;
    if (el.parentNode === this._stashArea) {
      this._scheduleStashedChildResize(el);
    } else {
      this._updateVirtualScrollableSize(el);
    }
  }

  private _markVisible(scrollable: VirtualScrollable, visible: boolean): void {
    if (scrollable instanceof Spacer) {
      return;
    }

    const scrollerArea = this._scrollArea;
    const element: ViewerElement = <any> scrollable;
    if ( ! visible) {

      if (this._terminalViewer !== element && ! (ViewerElement.isViewerElement(element) && element.hasFocus())) {
        // Move the scrollable into the stash area.
        this._stashArea.appendChild(element);
      }

    } else {

      if (element.parentElement !== scrollerArea) {
        // Move the element to the scroll area and place it in the correct position relative to the other child elements.

        const scrollerAreaChildrenCount = scrollerArea.children.length;
        if (scrollerAreaChildrenCount === 0) {
          scrollerArea.appendChild(element);
        } else {

          let scrollerIndex = 0;
          let childIndex = 0;
          while (childIndex < this._childElementList.length) {

            const currentElement = this._childElementList[childIndex].element;
            if (currentElement === element) {
              scrollerArea.insertBefore(element, scrollerArea.children[scrollerIndex]);
              break;
            }

            if (scrollerArea.children[scrollerIndex] === currentElement) {
              scrollerIndex++;
              if (scrollerIndex >= scrollerAreaChildrenCount) {
                scrollerArea.appendChild(element);
                break;
              }
            }
            childIndex++;
          }
        }

        // Set the current mode on the scrollable.
        const visualState = this._mode === Mode.CURSOR ? VisualState.AUTO : VisualState.FOCUSED;
        element.setMode(this._mode);
        element.setVisualState(visualState);
      }
    }
  }

  private _makeVisible(element: HTMLElement & VirtualScrollable): void {
    this._markVisible(element, true);
  }

  private _updateVirtualScrollableSize(virtualScrollable: VirtualScrollable): void {
    this._virtualScrollArea.updateScrollableSize(virtualScrollable);
    if (this._configDatabase != null) {
      const config = this._configDatabase.getConfig(GENERAL_CONFIG);
      this.enforceScrollbackSize(config.scrollbackMaxLines, config.scrollbackMaxFrames);
    }
  }

  refresh(level: ResizeRefreshElementBase.RefreshLevel): void {
    this._processRefresh(level);
  }
  
  private _processRefresh(requestedLevel: ResizeRefreshElementBase.RefreshLevel): void {
    let level = requestedLevel;
    if (this._needsCompleteRefresh) {
      level = ResizeRefreshElementBase.RefreshLevel.COMPLETE;
      this._needsCompleteRefresh = false;
    }

    const scrollerArea = this._scrollArea;
    if (scrollerArea !== null) {
      // --- DOM Read ---
      ResizeRefreshElementBase.ResizeRefreshElementBase.refreshChildNodes(scrollerArea, level);

      this._scrollBar.refresh(level);

      // --- DOM write ---
      this._virtualScrollArea.updateContainerHeight(this._scrollContainer.clientHeight);

      // Build the list of elements we will resize right now.
      const childrenToResize: VirtualScrollable[] = [];
      const len = scrollerArea.children.length;
      for (let i=0; i<len; i++) {
        const child = scrollerArea.children[i];
        if (ViewerElement.isViewerElement(child)) {
          childrenToResize.push(child);
        }
      }

      // Keep track of which children will need a resize later on.
      const childrenToResizeSet = new Set(childrenToResize);
      for (const childStatus of this._childElementList) {
        if ( ! childrenToResizeSet.has(childStatus.element)) {
          childStatus.needsRefresh = true;
          childStatus.refreshLevel = level;
        }
      }

      if (childrenToResize.length !== this._childElementList.length) {
        this._scheduleStashedChildResizeTask();
      }

      this._virtualScrollArea.updateScrollableSizes(childrenToResize);
      this._virtualScrollArea.reapplyState();

      if (this._configDatabase != null) {
        const config = this._configDatabase.getConfig(GENERAL_CONFIG);
        this.enforceScrollbackSize(config.scrollbackMaxLines, config.scrollbackMaxFrames);
      }
    }
  }

  private _setTopFunction(scrollable: VirtualScrollable, top: number):  void {
    if (scrollable instanceof Spacer) {
      return;
    }
    (<HTMLElement> (<any> scrollable)).style.top = "" + top + "px";
  }

  private _handleViewerCursor(ev: CustomEvent): void {
    const node = <Node> ev.target;
    if (ViewerElement.isViewerElement(node)) {
      this._scrollViewerCursorIntoView(node);
    } else {
      this._log.warn("_handleTerminalViewerCursor(): node is not a ViewerElement.");
    }
  }

  private _scrollViewerCursorIntoView(viewer: ViewerElement): void {
    const pos = viewer.getCursorPosition();
    const nodeTop = this._virtualScrollArea.getScrollableTop(viewer);
    const top = pos.top + nodeTop;
    const bottom = pos.bottom + nodeTop;
    this._virtualScrollArea.scrollIntoView(top, bottom);
  }

  scheduleResize(): void {
    this._scheduleResize();
  }

  private _scheduleResize(): void {
    this._scheduleLaterProcessing( () => {
      this._processRefresh(ResizeRefreshElementBase.RefreshLevel.RESIZE);
    });
  }

  private _scheduleStashedChildResize(el: HTMLElement & VirtualScrollable): void {
    if(el.parentNode !== this._stashArea) {
      return;
    }

    for (const childInfo of this._childElementList) {
      if (childInfo.element === el) {
        if ( ! childInfo.needsRefresh) {
          childInfo.needsRefresh = true;
          childInfo.refreshLevel = ResizeRefreshElementBase.RefreshLevel.RESIZE;
          this._scheduleStashedChildResizeTask();
        }
        return;
      }
    }

    this._log.warn("_scheduleStashedChildResize() called with an unknown element instance.");
  }
  private _scheduleStashedChildResizeTask(): void {
    if (this._stashedChildResizeTask == null) {
      this._stashedChildResizeTask = () => {
        // Gather the list of elements/scrollables that need refreshing and updating.
        const processList: ChildElementStatus[] = [];
        for (let i=this._childElementList.length-1; i>=0 && processList.length < CHILD_RESIZE_BATCH_SIZE; i--) {
          const childStatus = this._childElementList[i];
          if (childStatus.needsRefresh) {
            processList.push(childStatus);
            childStatus.needsRefresh = false;
          }
        }

        if (processList.length !== 0) {
          // Find the elements which need to be moved into the scroll area.
          const stashedList: (HTMLElement & VirtualScrollable)[] = [];
          for (const childStatus of processList) {
            const element = childStatus.element;
            if (element.parentElement !== this._scrollArea) {
              stashedList.push(element);
            }
          }

          stashedList.forEach(el => this._markVisible(el, true));

          for (const childStatus of processList) {
            const el = childStatus.element;
            if (ResizeRefreshElementBase.ResizeRefreshElementBase.is(el)) {
              el.refresh(childStatus.refreshLevel);
            }
          }

          this._virtualScrollArea.updateScrollableSizes(processList.map(childStatus => childStatus.element));

          if (stashedList.length !== 0) {
            stashedList.filter( (el) => ! this._virtualScrollArea.getScrollableVisible(el))
              .forEach( (el) => this._markVisible(el, false) );
          }

          this._scheduleStashedChildResizeTask();
        }
      };
    }

    if (this._scheduleLaterQueue.indexOf(this._stashedChildResizeTask) === -1) {
      this._scheduleLaterProcessing(this._stashedChildResizeTask);
    }
  }  

  private _scheduleLaterProcessing(func: Function): void {
    this._scheduleLaterQueue.push(func);
    
    if (this._scheduleLaterHandle === null) {
      this._scheduleLaterHandle = doLater( () => {
        this._scheduleLaterHandle = null;
        const queue = this._scheduleLaterQueue;
        this._scheduleLaterQueue = [];
        queue.forEach( (func) => func() );
      });
    }
  }
  private _handleViewerCursorEdge(ev: CustomEvent): void {
    const detail = <CursorEdgeDetail> ev.detail;
    const index = this._childElementListIndexOf(<any> ev.target);
    if (index === -1) {
      this._log.warn("_handleTerminalViewerCursorEdge(): Couldn't find the target.");
      return;
    }

    if (detail.edge === Edge.TOP) {
      // A top edge was hit. Move the cursor to the bottom of the ViewerElement above it.
      for (let i=index-1; i>=0; i--) {
        const node = this._childElementList[i].element;
        if (ViewerElement.isViewerElement(node)) {
          this._makeVisible(node);
          if (node.setCursorPositionBottom(detail.ch)) {
            DomUtils.focusWithoutScroll(node);
            this._scrollViewerCursorIntoView(node);
            break;
          }
        }
      }
    
    } else {
      // Bottom edge. Move the cursor to the top of the next ViewerElement.
      for (let i=index+1; i<this._childElementList.length; i++) {
        const node = this._childElementList[i].element;
        if (ViewerElement.isViewerElement(node)) {
          this._makeVisible(node);
          if (node.setCursorPositionTop(detail.ch)) {
            DomUtils.focusWithoutScroll(node);
            this._scrollViewerCursorIntoView(node);
            break;
          }
        }
      }
    }
  }

  // Run a function and only afterwards check the size of the scrollback.
  enforceScrollbackLengthAfter(func: () => any): any {
    const oldGuardFlag = this._enforceScrollbackLengthGuard;
    this._enforceScrollbackLengthGuard = true;
    const rc = func();
    this._enforceScrollbackLengthGuard = oldGuardFlag;

    if (this._configDatabase != null) {
      const config = this._configDatabase.getConfig(GENERAL_CONFIG);
      this.enforceScrollbackSize(config.scrollbackMaxLines, config.scrollbackMaxFrames);
    }
    return rc;
  }
  
  enforceScrollbackSize(maxScrollbackLines: number, maxScrollbackFrames: number): void {
    // Prevent the scrollback check from running multiple times.
    if (this._enforceScrollbackLengthGuard) {
      return;
    }
    this._enforceScrollbackLengthGuard = true;
// FIXME are these focus hacks needed still?    
    // const hasFocus = this.hasFocus();
    this._enforceScrollbackSize2(maxScrollbackLines, maxScrollbackFrames);
    // if (hasFocus && ! this.hasFocus()) {
    //   this.focus();
    // }
    this._enforceScrollbackLengthGuard = false;
  }

  private _enforceScrollbackSize2(maxScrollbackLines: number, maxScrollbackFrames: number): void {
    const windowHeight = window.screen.height;
    const killList: (VirtualScrollable & HTMLElement)[] = [];

    const childrenReverse = Array.from(this._childElementList);
    childrenReverse.reverse();

    // Skip past everything which could fit on one screen.
    let i = 0;
    let currentHeight = 0;
    while (i < childrenReverse.length) {
      const scrollableKid: VirtualScrollable & HTMLElement = <any> childrenReverse[i].element;
      const kidVirtualHeight = this._virtualScrollArea.getScrollableVirtualHeight(scrollableKid);
      if (currentHeight + kidVirtualHeight > windowHeight) {
        break;
      }
      currentHeight += kidVirtualHeight;
      i++;
    }

    let linesInScrollback = 0;

    // We may have found the element which straddles the visible top of the screen.
    if (i < childrenReverse.length) {
      const scrollableKid: VirtualScrollable & HTMLElement = <any> childrenReverse[i].element;
      i++;

      const textLikeViewer = this._castToTextLikeViewer(scrollableKid);
      if (textLikeViewer != null) {
        const visibleRows = textLikeViewer.pixelHeightToRows(windowHeight - currentHeight);
        linesInScrollback = textLikeViewer.lineCount() - visibleRows;
        if (linesInScrollback > maxScrollbackLines) {

          if (TerminalViewer.is(scrollableKid)) {
            // Trim it.
            textLikeViewer.deleteTopLines(linesInScrollback - maxScrollbackLines);
          } else {
            // Delete it outright.
            killList.push(scrollableKid);
          }

          while (i < childrenReverse.length) {
            killList.push(childrenReverse[i].element);
            i++;
          }
          i = childrenReverse.length;
        }
      }
    }

    let frameCount = 0;
    while (i < childrenReverse.length) {
      const scrollableKid: VirtualScrollable & HTMLElement = <any> childrenReverse[i].element;
      i++;
      frameCount++;

      const textLikeViewer = this._castToTextLikeViewer(scrollableKid);
      if (textLikeViewer != null) {
        linesInScrollback += textLikeViewer.lineCount();
        if (frameCount > maxScrollbackFrames || linesInScrollback > maxScrollbackLines) {
          
          // We've hit a limit. Delete the rest.
          killList.push(scrollableKid);
          while (i < childrenReverse.length) {
            killList.push(childrenReverse[i].element);
            i++;
          }
          i = childrenReverse.length;
        }

        linesInScrollback += textLikeViewer.lineCount();
      }
    }

    for (const scrollableKid of killList) {
      this.removeScrollable(scrollableKid);
    }
  }

  private _castToTextLikeViewer(kidNode: HTMLElement): {
      deleteTopLines(lines: number): void;
      lineCount(): number;
      pixelHeightToRows(pixelHeight: number): number; } {

    if (TerminalViewer.is(kidNode)) {
      return kidNode;
    } else if (EmbeddedViewer.is(kidNode)) {
      const viewer = kidNode.getViewerElement();
      if (TerminalViewer.is(viewer)) {
        return viewer;  
      } else if (TextViewer.is(viewer)) {
        return viewer;
      }
    }
    return null;
  }

  goToPreviousFrame(): void {
    const heights = this._virtualScrollArea.getScrollableHeightsIncSpacing();

    const y = this._virtualScrollArea.getScrollYOffset();
    let heightCount = 0;
    for (let i=0; i<heights.length; i++) {
      if (y <= (heightCount + heights[i].height)) {
        this._virtualScrollArea.scrollTo(heightCount);
        break;
      }
      heightCount += heights[i].height;
    }
  }

  goToNextFrame(): void {
    const heights = this._virtualScrollArea.getScrollableHeightsIncSpacing();

    const y = this._virtualScrollArea.getScrollYOffset();
    let heightCount = 0;
    for (let i=0; i<heights.length; i++) {
      if (y < (heightCount + heights[i].height)) {
        this._virtualScrollArea.scrollTo(heightCount + heights[i].height);
        break;
      }
      heightCount += heights[i].height;
    }
  }

  scrollPageUp(): void {
    this._virtualScrollArea.scrollTo(this._virtualScrollArea.getScrollYOffset()
      - this._virtualScrollArea.getScrollContainerHeight() / 2);
  }

  scrollPageDown(): void {
    this._virtualScrollArea.scrollTo(this._virtualScrollArea.getScrollYOffset()
      + this._virtualScrollArea.getScrollContainerHeight() / 2);
  }

  getLastEmbeddedViewer(): EmbeddedViewer {
    const kids = this._childElementList;
    const len = this._childElementList.length;
    for (let i=len-1; i>=0;i--) {
      const kid = kids[i].element;
      if (EmbeddedViewer.is(kid)) {
        return kid;
      }
    }
    return null;
  }

  getChildElements(): HTMLElement[] {
    return this._childElementList.map(x => x.element);
  }

  getSelectionText(): string {
    let text: string = null;
    for (let i=0; i<this._childElementList.length; i++) {
      const node = this._childElementList[i].element;
      if (ViewerElement.isViewerElement(node)) {
        text = node.getSelectionText();
        if (text !== null) {
          return text;
        }
      }
    }
    return null;
  }
}
