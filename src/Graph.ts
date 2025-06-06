import {
    ArcRotateCamera,
    Camera,
    Engine,
    HemisphericLight,
    Observable,
    PhotoDome,
    Scene,
    Vector3,
    WebXRDefaultExperience,
    WebXREnterExitUIButton,
} from "@babylonjs/core";

import {
    EdgeEvent,
    EventCallbackType,
    EventType,
    GraphEvent,
    NodeEvent,
} from "./events";

import {
    FetchEdgesFn,
    FetchNodesFn,
    GraphConfig,
    GraphEngineNamesType,
    GraphOptsType,
    LoadJsonDataConfig,
    getConfig,
    getJsonDataOpts,
} from "./config";

import {D3GraphEngine} from "./engine/D3GraphEngine";
import {Edge, EdgeMap} from "./Edge";
import {GraphEngine} from "./engine/GraphEngine";
import {MeshCache} from "./MeshCache";
import {NGraphEngine} from "./engine/NGraphEngine";
import {Node, NodeIdType} from "./Node";
import {Stats} from "./Stats";
import {Styles} from "./Styles";
import jmespath from "jmespath";

export class Graph {
    config: GraphConfig;
    stats: Stats;
    styles: Styles;
    // babylon
    element: Element;
    canvas: HTMLCanvasElement;
    engine: Engine;
    scene: Scene;
    camera: Camera;
    skybox?: string;
    xrHelper?: WebXRDefaultExperience;
    meshCache: MeshCache;
    edgeCache: EdgeMap = new EdgeMap();
    nodeCache: Map<NodeIdType, Node> = new Map();
    // graph engine
    graphEngineType?: GraphEngineNamesType;
    graphEngine: GraphEngine;
    running = true;
    pinOnDrag?: boolean;
    // graph
    fetchNodes?: FetchNodesFn;
    fetchEdges?: FetchEdgesFn;
    initialized = false;
    // observeables
    graphObservable: Observable<GraphEvent> = new Observable();
    nodeObservable: Observable<NodeEvent> = new Observable();
    edgeObservable: Observable<EdgeEvent> = new Observable();

    constructor(element: Element | string, opts?: GraphOptsType) {
        this.config = getConfig(opts);
        this.meshCache = new MeshCache();

        // configure graph
        this.styles = new Styles({addDefaultStyle: true});
        if (this.config.behavior.fetchNodes) {
            this.fetchNodes = this.config.behavior.fetchNodes as FetchNodesFn;
        }

        if (this.config.behavior.fetchEdges) {
            this.fetchEdges = this.config.behavior.fetchEdges as FetchEdgesFn;
        }

        // get the element that we are going to use for placing our canvas
        if (typeof (element) === "string") {
            const e: Element | null = document.getElementById(element);
            if (!e) {
                throw new Error(`getElementById() could not find element '${element}'`);
            }

            this.element = e;
        } else if (element instanceof Element) {
            this.element = element;
        } else {
            throw new TypeError("Graph constructor requires 'element' argument that is either a string specifying the ID of the HTML element or an Element");
        }

        this.element.innerHTML = "";

        // get a canvas element for rendering
        this.canvas = document.createElement("canvas");
        this.canvas.setAttribute("id", `babylonForceGraphRenderCanvas${Date.now()}`);
        this.canvas.setAttribute("touch-action", "none");
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.canvas.style.touchAction = "none";
        this.element.appendChild(this.canvas);

        // setup babylonjs
        this.engine = new Engine(this.canvas, true); // Generate the BABYLON 3D engine
        this.scene = new Scene(this.engine);
        this.camera = new ArcRotateCamera(
            "camera",
            -Math.PI / 2,
            Math.PI / 2.5,
            this.config.style.startingCameraDistance,
            new Vector3(0, 0, 0),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (this.camera as any).lowerBetaLimit;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (this.camera as any).upperBetaLimit;
        this.camera.attachControl(this.canvas, true);
        new HemisphericLight("light", new Vector3(1, 1, 0));

        // setup PhotoDome Skybox
        if (this.config.style.skybox && this.config.style.skybox.length) {
            new PhotoDome(
                "testdome",
                this.config.style.skybox,
                {
                    resolution: 32,
                    size: 1000,
                },
                this.scene,
            );
        }

        // setup force directed graph engine
        if (this.config.engine.type === "ngraph") {
            this.graphEngine = new NGraphEngine();
        } else if (this.config.engine.type === "d3") {
            this.graphEngine = new D3GraphEngine();
        } else {
            throw new TypeError(`Unknown graph engine type: '${this.graphEngineType}'`);
        }

        // setup stats
        this.stats = new Stats(this);

        // setup data
        // if (this.config.data) {
        //     if (this.config.data.nodes) {
        //         this.addNodes(this.config.data.nodes);
        //     }
        //     if (this.config.data.edges) {
        //         this.addEdges(this.config.data.edges);
        //     }
        // }

        // run layout
        for (let i = 0; i < this.config.engine.preSteps; i++) {
            this.graphEngine.step();
        }
    }

    shutdown() {
        this.engine.dispose();
    }

    async init() {
        if (this.initialized) {
            return;
        }

        // Register a render loop to repeatedly render the scene
        this.engine.runRenderLoop(() => {
            this.update();
            this.scene.render();
        });

        // add enter vr / ar buttons
        addCss();
        const buttonsArray = [
            mkButton("VR", "immersive-vr", "local-floor"),
            mkButton("AR", "immersive-ar", "local-floor"),
        ];

        // WebXR setup
        if (navigator.xr) {
            this.xrHelper = await this.scene.createDefaultXRExperienceAsync({
                uiOptions: {
                    customButtons: buttonsArray,
                },
                disableTeleportation: true,
                // optionalFeatures: true,
                // outputCanvasOptions: {
                //     canvasOptions: {
                //         framebufferScaleFactor: 0.5,
                //     },
                // },
            });

            this.xrHelper.baseExperience.onInitialXRPoseSetObservable.add((cam) => {
                // initial VR position is fine; initial AR position appears to
                // be the origin
                if (this.xrHelper?.baseExperience.sessionManager.sessionMode === "immersive-ar") {
                    cam.setTransformationFromNonVRCamera(this.camera);
                }
            });

            const overlay = document.querySelector(".xr-button-overlay");
            if (overlay) {
                // position the overlay so that the buttons are visible
                (overlay as HTMLElement).style.cssText = "z-index:11;position: absolute; right: 20px;bottom: 50px;";
            }
        } else {
            // createDefaultXRExperienceAsync creates it's own overlay, but we
            // don't get that benefit here...
            const overlay = addButtonOverlay(this);

            // create html button
            const noXrBtn = document.createElement("button");
            noXrBtn.classList.add("webxr-button");
            noXrBtn.classList.add("webxr-not-available");
            noXrBtn.innerHTML = "VR / AR NOT AVAILABLE";
            overlay.appendChild(noXrBtn);
            setTimeout(() => {
                overlay.remove();
            }, 5000);
        }

        // Watch for browser/canvas resize events
        window.addEventListener("resize", () => {
            this.engine.resize();
        });

        this.initialized = true;
    }

    update() {
        if (!this.running) {
            return;
        }

        // update graph engine
        this.stats.step();
        this.stats.graphStep.beginMonitoring();
        for (let i = 0; i < this.config.engine.stepMultiplier; i++) {
            this.graphEngine.step();
        }
        this.stats.graphStep.endMonitoring();

        // update nodes
        this.stats.nodeUpdate.beginMonitoring();
        for (const n of this.graphEngine.nodes) {
            n.update();
        }
        this.stats.nodeUpdate.endMonitoring();

        // update edges
        this.stats.edgeUpdate.beginMonitoring();
        Edge.updateRays(this);
        for (const e of this.graphEngine.edges) {
            e.update();
        }
        this.stats.edgeUpdate.endMonitoring();

        // check to see if we are done
        if (this.graphEngine.isSettled) {
            this.graphObservable.notifyObservers({type: "graph-settled", graph: this});
            this.running = false;
        }
    }

    addNode(node: object, idPath?: string) {
        return this.addNodes([node], idPath);
    }

    addNodes(nodes: Array<object>, idPath?: string) {
        // create path to node ids
        const query = idPath || this.config.knownFields.nodeIdPath;

        // update styles
        this.styles.addNodes(nodes);

        // create nodes
        for (const node of nodes) {
            const metadata = node;
            const nodeId = jmespath.search(node, query);
            this.nodeObservable.notifyObservers({type: "node-add-before", nodeId, metadata});
            const style = this.styles.getStyleForNode(nodeId);
            Node.create(this, nodeId, style, {
                pinOnDrag: this.pinOnDrag,
                metadata,
            });
        }
    }

    addEdge(edge: object, srcIdPath?: string, dstIdPath?: string) {
        this.addEdges([edge], srcIdPath, dstIdPath);
    }

    addEdges(edges: Array<object>, srcIdPath?: string, dstIdPath?: string) {
        // get paths
        const srcQuery = srcIdPath || this.config.knownFields.edgeSrcIdPath;
        const dstQuery = dstIdPath || this.config.knownFields.edgeDstIdPath;

        // update styles
        this.styles.addEdges(edges);

        // create nodes
        for (const edge of edges) {
            const metadata = edge;
            const srcNodeId = jmespath.search(edge, srcQuery);
            const dstNodeId = jmespath.search(edge, dstQuery);
            this.edgeObservable.notifyObservers({type: "edge-add-before", srcNodeId, dstNodeId, metadata});
            const style = this.styles.getStyleForEdge(srcNodeId, dstNodeId);
            Edge.create(this, srcNodeId, dstNodeId, style, {
                metadata,
            });
        }
    }

    addListener(type: EventType, cb: EventCallbackType): void {
        switch (type) {
        case "graph-settled":
            this.graphObservable.add((e) => {
                if (e.type === type) {
                    cb(e);
                }
            });
            break;
        case "node-add-before":
            this.nodeObservable.add((e) => {
                if (e.type === type) {
                    cb(e);
                }
            });
            break;
        case "edge-add-before":
            this.edgeObservable.add((e) => {
                if (e.type === type) {
                    cb(e);
                }
            });
            break;
        default:
            throw new TypeError(`Unknown listener type in addListener: ${type}`);
        }
    }

    async loadJsonData(url: string, opts?: LoadJsonDataConfig): Promise<void> {
        this.stats.loadTime.beginMonitoring();
        const {nodeListProp, edgeListProp, nodeIdProp, edgeSrcIdProp, edgeDstIdProp, fetchOpts} = getJsonDataOpts(opts);

        // fetch data from URL
        const response = await fetch(url, fetchOpts);
        const data = await response.json();

        // check data
        if (!Array.isArray(data[nodeListProp])) {
            throw TypeError(`when fetching JSON data: '${nodeListProp}' was not an Array`);
        }

        if (!Array.isArray(data[edgeListProp])) {
            throw TypeError(`when fetching JSON data: '${edgeListProp}' was not an Array`);
        }

        // iterate nodes adding data
        for (const n of data[nodeListProp]) {
            const id = n[nodeIdProp];
            const metadata = n;
            this.addNode(id, metadata);
        }

        // iterate edges adding data
        for (const e of data[edgeListProp]) {
            const srcId = e[edgeSrcIdProp];
            const dstId = e[edgeDstIdProp];
            const metadata = e;
            this.addEdge(srcId, dstId, metadata);
        }
        this.stats.loadTime.endMonitoring();
    }
}

function mkButton(text: string, sessionMode?: XRSessionMode, referenceSpaceType?: XRReferenceSpaceType): WebXREnterExitUIButton {
    sessionMode = sessionMode || "immersive-vr";
    referenceSpaceType = referenceSpaceType || "local-floor";

    // create html button
    const btnElement = document.createElement("button");
    btnElement.classList.add("webxr-button");
    btnElement.classList.add("webxr-available");
    btnElement.innerHTML = text;

    // create babylon button
    const xrBtn = new WebXREnterExitUIButton(btnElement, sessionMode, referenceSpaceType);
    xrBtn.update = function(activeButton: WebXREnterExitUIButton | null) {
        if (activeButton === null) {
            // not active, show button and remove presenting style (if present)
            btnElement.style.display = "";
            btnElement.classList.remove("webxr-presenting");
        } else if (activeButton === xrBtn) {
            // this button is active, change it to presenting
            btnElement.style.display = "";
            btnElement.classList.add("webxr-presenting");
        } else {
            // some button is active, but not this one... hide this button
            btnElement.style.display = "none";
        }
    };

    return xrBtn;
}

function addCss() {
    const css = `
    .webxr-button {
        font-family: 'Verdana', sans-serif;
        font-size: 1em;
        font-weight: bold;
        color: white;
        border: 2px solid white;
        padding: 4px 16px 4px 16px;
        margin-left: 10px;
        border-radius: 8px;
    }

    .webxr-available {
        background: black;
        box-shadow:0 0 0 0px white, 0 0 0 2px black;
    }

    .webxr-presenting {
        background: red;
    }

    .webxr-presenting::before {
        content: "EXIT ";
    }

    .webxr-not-available {
        background: grey;
        box-shadow:0 0 0 0px white, 0 0 0 2px grey;
    }

    .webxr-available:hover {
        transform: scale(1.05);
    } 

    .webxr-available:active {
        background-color: rgba(51,51,51,1);
    } 
    
    .webxr-available:focus {
        background-color: rgba(51,51,51,1);
    }
    
    canvas {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        -khtml-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
        outline: none;
        -webkit-tap-highlight-color: rgba(255, 255, 255, 0); /* mobile webkit */
    }`;

    const style = document.createElement("style");
    style.appendChild(document.createTextNode(css));
    document.getElementsByTagName("head")[0].appendChild(style);
}

function addButtonOverlay(g: Graph): HTMLElement {
    const overlay = document.createElement("div");
    overlay.classList.add("xr-button-overlay");
    overlay.style.cssText = "z-index:11;position: absolute; right: 20px;bottom: 50px;";
    const renderCanvas = g.scene.getEngine().getInputElement();
    if (renderCanvas && renderCanvas.parentNode) {
        renderCanvas.parentNode.appendChild(overlay);
    }

    return overlay;
}
