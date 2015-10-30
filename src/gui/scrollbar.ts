/**
 * Copyright 2014-2015 Simon Edwards <simon@simonzone.com>
 */
import util = require('./util');

const ID = "CbScrollbarTemplate";
const ID_AREA = "area";
const ID_CONTAINER = "container";

let registered = false;

class CbScrollbar extends HTMLElement {
  
  static TAG_NAME = 'cb-scrollbar';
  
  static ATTR_LENGTH = "length";
  
  static ATTR_POSITION = "position";
  
  static ATTR_THUMBSIZE = "thumbsize";
  
  static init(): void {
    if (registered === false) {
      window.document.registerElement(CbScrollbar.TAG_NAME, {prototype: CbScrollbar.prototype});
      registered = true;
    }
  }
  
  // WARNING: Fields like this will not be initialised automatically.
  private _position: number;
  
  private _length: number;
  
  private _css() {
    return `
      :host {
          display: block;
          color: transparent;
      }
      #container {
        width: 17px;
        height: 100%;
        overflow-x: hidden;
        overflow-y: scroll;
      }
      #area {
        width: 1px;
        height: 1px;
      }`;
  }

  private _html(): string {
    return `<div id='${ID_CONTAINER}'><div id='${ID_AREA}'></div></div>`;
  }
  
  private _initProperties(): void {
    this._position = 0;
    this._length = 1;
  }
  
  createdCallback(): void {
    this._initProperties(); // Initialise our properties. The constructor was not called.
    
    var shadow = util.createShadowRoot(this);
    var clone = this._createClone();
    shadow.appendChild(clone);
    this._getById(ID_CONTAINER).addEventListener('scroll', (ev: Event) => {
      var container = this._getById(ID_CONTAINER);
      var top = container.scrollTop;
      this._position = top;
      var event = new CustomEvent('scroll',
          { detail: {
            position: top,
            isTop: top === 0,
            isBottom: (container.scrollHeight - container.clientHeight) === top } });
      this.dispatchEvent(event);
    });
    
    this._updateLength(this.getAttribute(CbScrollbar.ATTR_LENGTH));
    this._updatePosition(this.getAttribute(CbScrollbar.ATTR_POSITION));
  }
  
  private _createClone(): Node {
    var template: HTMLTemplate = <HTMLTemplate>window.document.getElementById(ID);
    if (template === null) {
      template = <HTMLTemplate>window.document.createElement('template');
      template.id = ID;
      template.innerHTML = "<style>" + this._css() + "</style>\n" + this._html();
      window.document.body.appendChild(template);
    }
    return window.document.importNode(template.content, true);
  }

  private _getById(id: string): HTMLElement {
    return <HTMLElement>util.getShadowRoot(this).querySelector('#'+id);
  }


  attributeChangedCallback(attrName: string, oldValue: string, newValue: string): void {
    switch (attrName) {
      case CbScrollbar.ATTR_LENGTH:
        this._updateLength(newValue);
        break;

      case CbScrollbar.ATTR_POSITION:
        this._updatePosition(newValue);
        break;
        
      default:
        break;
    }
  }
  
  // --- Length attribute ---
  set length(value: number) {
    if (value !== this._length) {
      this._length = Math.max(0, value);
      this._updateLengthNumber(this._length);
    }
  }
  
  get length(): number {
    return this._length;
  }
  
  private _updateLength(value: string): void {
    if (value === null || value === undefined) {
      return;
    }
    var numberValue = parseInt(value, 10);
    if (isNaN(numberValue)) {
      console.warn("Value '" + value + "'to scrollbar attribute '" + CbScrollbar.ATTR_LENGTH + "' was NaN.");
      return;
    }
    this.length = numberValue;
  }
  
  private _updateLengthNumber(value: number): void {
    var areaElement = this._getById(ID_AREA);
    areaElement.style.height = value + "px";
  }
  
  // --- Position attribute ---
  set position(value: number) {
    var container = this._getById(ID_CONTAINER);
    var cleanValue = Math.min(container.scrollHeight-container.clientHeight, Math.max(0, value));
    if (cleanValue !== this._position) {
      this._position = cleanValue;
      this._updatePositionNumber(this._position);
    }
  }
  
  get position(): number {
    return this._position;
  }
  
  private _updatePosition(value: string): void {
    if (value === null || value === undefined) {
      return;
    }
    var numberValue = parseInt(value, 10);
    if (isNaN(numberValue)) {
      console.warn("Value '" + value + "'to scrollbar attribute '" + CbScrollbar.ATTR_LENGTH + "' was NaN.");
      return;
    }
    this.position = numberValue;
  }
  
  private _updatePositionNumber(value: number): void {
    var containerElement = this._getById(ID_CONTAINER);
    containerElement.scrollTop = value;
  }
  
  // --- Thumbsize attribute ---
  set thumbSize(size: number) {
    
  }
  
  get thumbSize(): number {
    return 7734;  // FIXME bogus.
  }
}

export = CbScrollbar;
