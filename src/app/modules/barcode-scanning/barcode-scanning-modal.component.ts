import {
	AfterViewInit,
	Component,
	ElementRef,
	Input,
	NgZone,
	OnDestroy,
	OnInit,
	ViewChild,
} from '@angular/core';
import { DialogService } from '@app/core';
import {
	Barcode,
	BarcodeFormat,
	BarcodeScanner,
	LensFacing,
	StartScanOptions,
} from '@capacitor-mlkit/barcode-scanning';
import { InputCustomEvent } from '@ionic/angular';
import { delay, filter, mergeMap, of, Subject, tap } from 'rxjs';
import { ComponentStore } from '@ngrx/component-store';

const POSITIVE_SCAN_THRESHOLD = 3;
const API_LATENCY_MS = 2500;
const KEEP_SCANNING_AFTER_MATCH = false;

enum BarcodeSearchStatus {
	scanned = 'Scanned',
	rejected = 'Rejected',
	matched = 'Matched',
}

type BarcodeScanResults = Barcode & {
	count: number;
	searchStatus: BarcodeSearchStatus;
	timestamp: Date;
};

interface BarcodeScannerState {
	scanResults: Record<string, BarcodeScanResults>;
}

@Component({
	selector: 'app-barcode-scanning',
	templateUrl: 'barcode-scanning-modal.component.html',
	styleUrls: ['barcode-scanning-modal.component.scss'],
})
export class BarcodeScanningModalComponent
	extends ComponentStore<BarcodeScannerState>
	implements OnInit, AfterViewInit, OnDestroy
{
	@Input()
	public formats: BarcodeFormat[] = [];
	@Input()
	public lensFacing: LensFacing = LensFacing.Back;

	@ViewChild('square')
	public squareElement: ElementRef<HTMLDivElement> | undefined;

	@ViewChild('overlayCanvas', { static: false })
	public canvas: ElementRef<HTMLCanvasElement> | undefined;

	cx: CanvasRenderingContext2D | null | undefined;

	public isTorchAvailable = false;
	public minZoomRatio: number | undefined;
	public maxZoomRatio: number | undefined;

	resizeCanvas() {
		if (this.canvas) {
			this.canvas.nativeElement.width = window.innerWidth;
			this.canvas.nativeElement.height = window.innerHeight;
		}
		/**
		 * Your drawings need to be inside this function otherwise they will be reset when
		 * you resize the browser window and the canvas goes will be cleared.
		 */
	}

	public ngOnInit(): void {
		BarcodeScanner.isTorchAvailable().then((result) => {
			this.isTorchAvailable = result.available;
		});
	}

	public ngAfterViewInit(): void {
		this.resizeCanvas();
		setTimeout(() => {
			this.startScan();
		}, 250);
	}

	public async ngOnDestroy() {
		await this.stopScan();
		console.log('Destroy!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
	}

	public setZoomRatio(event: InputCustomEvent): void {
		if (!event.detail.value) {
			return;
		}
		BarcodeScanner.setZoomRatio({
			zoomRatio: parseInt(event.detail.value as any, 10),
		});
	}

	public async closeModal(barcode?: Barcode): Promise<void> {
		this.dialogService.dismissModal({
			barcode: barcode,
		});
	}

	public async toggleTorch(): Promise<void> {
		await BarcodeScanner.toggleTorch();
	}

	readonly barcodeScanned$ = new Subject<Barcode>();

	private async startScan(): Promise<void> {
		// Hide everything behind the modal (see `src/theme/variables.scss`)
		document.querySelector('body')?.classList.add('barcode-scanning-active');

		const options: StartScanOptions = {
			formats: this.formats,
			lensFacing: this.lensFacing,
		};

		await BarcodeScanner.addListener('barcodeScanned', async (event) => {
			this.ngZone.run(() => {
				//this.updateScanResults(event.barcode);
				this.barcodeScanned$.next(event.barcode);
			});
		});

		await BarcodeScanner.startScan(options);

		BarcodeScanner.getZoomRatio().then((zoomRatio) =>
			console.log('zoom', zoomRatio),
		);
		void BarcodeScanner.getMinZoomRatio().then((result) => {
			this.minZoomRatio = result.zoomRatio;
		});
		void BarcodeScanner.getMaxZoomRatio().then((result) => {
			this.maxZoomRatio = result.zoomRatio;
		});
	}

	// *** Selectors ***

	readonly scanResults$ = this.select((state) => state.scanResults);

	readonly barcodesFilteredArray$ = this.select(
		this.scanResults$,
		(barcodes) =>
			Object.values(barcodes)
				.filter((item) => item.count >= POSITIVE_SCAN_THRESHOLD)
				.sort((a, b) => b.count - a.count),
		{ debounce: true },
	);

	readonly newBarcode$ = this.select(
		this.barcodesFilteredArray$,
		(barcodes) => barcodes.slice(-1)[0],
		{ debounce: true },
	).pipe(
		filter(isNotNullOrUndefined),
		filter((barcode) => barcode?.count === POSITIVE_SCAN_THRESHOLD),
		tap((nb) => console.log('nb', nb)),
	);

	readonly barcodesView$ = this.select(
		this.barcodesFilteredArray$,
		(array) =>
			array.map((barcode) => ({
				count: barcode.count,
				value: barcode.displayValue,
				searchStatus: barcode.searchStatus,
			})),
		{ debounce: true },
	);

	// *** Updaters ***
	readonly updateScanResults = this.updater<Barcode>((state, barcode) => ({
		...state,
		scanResults: {
			...state.scanResults,
			[barcode.displayValue]: {
				...(state.scanResults[barcode.displayValue]
					? {
							...state.scanResults[barcode.displayValue],
							...barcode,
							count: state.scanResults[barcode.displayValue].count + 1,
							timestamp: new Date(),
						}
					: {
							...barcode,
							count: 1,
							searchStatus: BarcodeSearchStatus.scanned,
							timestamp: new Date(),
						}),
			},
		},
	}));

	readonly updateBarcodeSearchStatus = this.updater<{
		barcodeValue: string;
		searchStatus: BarcodeSearchStatus;
	}>((state, { barcodeValue, searchStatus }) => ({
		...state,
		scanResults: {
			...state.scanResults,
			[barcodeValue]: {
				...state.scanResults[barcodeValue],
				searchStatus,
			},
		},
	}));

	// *** Effects **

	readonly searchNewBarcodes = this.effect<BarcodeScanResults>((barcode$) =>
		barcode$.pipe(
			mergeMap((barcode) =>
				of({ barcode, matched: this.isMatch(barcode.displayValue) }).pipe(
					//simulate an API call with a random latency
					delay(API_LATENCY_MS + Math.floor(Math.random() * API_LATENCY_MS)),
				),
			),
			tap(({ barcode, matched }) => {
				if (matched) {
					if (!KEEP_SCANNING_AFTER_MATCH) {
						this.stopScan();
					}
					this.beep(BarcodeSearchStatus.matched);
				} else {
					this.beep(BarcodeSearchStatus.rejected);
				}
				this.updateBarcodeSearchStatus({
					barcodeValue: barcode.displayValue,
					searchStatus: matched
						? BarcodeSearchStatus.matched
						: BarcodeSearchStatus.rejected,
				});
			}),
		),
	);

	clearCanvas() {
		const canvasEl: HTMLCanvasElement | undefined = this.canvas?.nativeElement;
		const cx = canvasEl?.getContext('2d');
		if (cx && canvasEl) {
			console.log('clearing canvas', canvasEl.width, canvasEl.height);
			cx.clearRect(0, 0, canvasEl.width * 2, canvasEl.height * 2);
		}
	}

	readonly drawBoxes = this.effect<BarcodeScanResults[]>(
		(filteredScanResults$) =>
			filteredScanResults$.pipe(
				//throttleTime(1000),
				tap((filteredScanResults) => {
					console.log('Drawing boxes');
					const canvasEl: HTMLCanvasElement | undefined =
						this.canvas?.nativeElement;
					const cx = canvasEl?.getContext('2d');

					if (!!cx && canvasEl) {
						cx.clearRect(0, 0, canvasEl.width, canvasEl.height);
						cx.lineWidth = 1;
						cx.lineCap = 'round';
						cx.lineJoin = 'round';
						cx.strokeStyle = 'yellow';

						filteredScanResults.forEach((filteredScanResult) => {
							//console.log('!!!!!', filteredScanResult);
							const cornerPoints = filteredScanResult.cornerPoints;

							const isStale =
								new Date().getTime() - filteredScanResult.timestamp.getTime() >
								1000;
							if (cornerPoints && !isStale) {
								cx.beginPath();
								const scale = 0.36;
								cornerPoints.forEach(([x, y], index) => {
									index === 0
										? cx.moveTo(x * scale, y * scale)
										: cx.lineTo(x * scale, y * scale);
								});
								cx.closePath();
								cx.stroke();
							}
						});
					}
					console.log('Done drawing boxes');
				}),
			),
	);

	private isMatch(barcodeValue: string) {
		return barcodeValue.startsWith('S') || barcodeValue.startsWith('CAT');
	}

	private async stopScan(): Promise<void> {
		console.log('stopScan');

		await BarcodeScanner.stopScan();
		console.log('removeAllListeners');

		await BarcodeScanner.removeAllListeners();

		setTimeout(() => {
			console.log('clearCanvas');
			this.clearCanvas();
			console.log('remove barcode-scanning-active');
			document
				.querySelector('body')
				?.classList.remove('barcode-scanning-active');
		}, 500);
	}

	beep(barcodeSearchStatus: BarcodeSearchStatus) {
		console.log('beep', barcodeSearchStatus);
		sounds[barcodeSearchStatus]?.play();
	}

	constructor(
		private readonly dialogService: DialogService,
		private readonly ngZone: NgZone,
		private el: ElementRef,
	) {
		super({
			scanResults: {},
		});

		this.searchNewBarcodes(this.newBarcode$);

		this.drawBoxes(this.barcodesFilteredArray$);

		this.barcodeScanned$
			.pipe(tap((barcode) => this.updateScanResults(barcode)))
			.subscribe((barcode) => console.log(barcode));

		this.newBarcode$.subscribe(() => this.beep(BarcodeSearchStatus.scanned));
	}
}

export function isNotNullOrUndefined<T>(
	value: null | undefined | T,
): value is T {
	return value !== null && value !== undefined;
}

const sounds = {
	[BarcodeSearchStatus.rejected]: undefined, //new Audio('/assets/audio/rejected.mp3'),
	[BarcodeSearchStatus.matched]: new Audio('/assets/audio/matched.mp3'),
	[BarcodeSearchStatus.scanned]: new Audio('/assets/audio/scanned.wav'),
};
