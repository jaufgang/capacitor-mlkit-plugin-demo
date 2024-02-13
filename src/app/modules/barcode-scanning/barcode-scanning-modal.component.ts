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
import { delay, filter, map, mergeMap, of, pairwise, tap } from 'rxjs';
import { ComponentStore } from '@ngrx/component-store';

const POSITIVE_SCAN_THRESHOLD = 3;
const API_LATENCY_MS = 250;
const KEEP_SCANNING_AFTER_MATCH = false;

enum BarcodeSearchStatus {
	scanned = 'Scanned',
	rejected = 'Rejected',
	matched = 'Matched',
}

type BarcodeScanResults = Barcode & {
	count: number;
	searchStatus: BarcodeSearchStatus;
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

	public isTorchAvailable = false;
	public minZoomRatio: number | undefined;
	public maxZoomRatio: number | undefined;

	public ngOnInit(): void {
		BarcodeScanner.isTorchAvailable().then((result) => {
			this.isTorchAvailable = result.available;
		});
	}

	public ngAfterViewInit(): void {
		setTimeout(() => {
			this.startScan();
		}, 250);
	}

	public ngOnDestroy(): void {
		this.stopScan();
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

	private async startScan(): Promise<void> {
		// Hide everything behind the modal (see `src/theme/variables.scss`)
		document.querySelector('body')?.classList.add('barcode-scanning-active');

		const options: StartScanOptions = {
			formats: this.formats,
			lensFacing: this.lensFacing,
		};

		const listener = await BarcodeScanner.addListener(
			'barcodeScanned',
			async (event) => {
				this.ngZone.run(() => {
					this.updateScanResults(event.barcode);
				});
			},
		);
		await BarcodeScanner.startScan(options);
		void BarcodeScanner.getMinZoomRatio().then((result) => {
			this.minZoomRatio = result.zoomRatio;
		});
		void BarcodeScanner.getMaxZoomRatio().then((result) => {
			this.maxZoomRatio = result.zoomRatio;
		});
	}

	// *** Selectors ***

	readonly scanResults$ = this.select((state) => state.scanResults);

	readonly barcodesFilteredArray$ = this.scanResults$.pipe(
		map((barcodes) =>
			Object.values(barcodes)
				.filter((item) => item.count >= POSITIVE_SCAN_THRESHOLD)
				.sort((a, b) => b.count - a.count),
		),
	);

	readonly newBarcode$ = this.barcodesFilteredArray$.pipe(
		map((barcodes) => barcodes.slice(-1)[0]),
		filter(isNotNullOrUndefined),
		filter((barcode) => barcode?.count === POSITIVE_SCAN_THRESHOLD),
		tap((nb) => console.log('nb', nb)),
	);

	readonly barcodesView$ = this.barcodesFilteredArray$.pipe(
		map((array) =>
			array.map((barcode) => ({
				count: barcode.count,
				value: barcode.displayValue,
				searchStatus: barcode.searchStatus,
			})),
		),
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
							count: state.scanResults[barcode.displayValue].count + 1,
						}
					: {
							...barcode,
							count: 1,
							searchStatus: BarcodeSearchStatus.scanned,
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

	private isMatch(barcodeValue: string) {
		return barcodeValue.startsWith('S') || barcodeValue.startsWith('CAT');
	}

	private async stopScan(): Promise<void> {
		// Show everything behind the modal again

		document.querySelector('body')?.classList.remove('barcode-scanning-active');

		await BarcodeScanner.stopScan();
	}

	beep(barcodeSearchStatus: BarcodeSearchStatus) {
		console.log('beep', barcodeSearchStatus);
		sounds[barcodeSearchStatus]?.play();
	}

	constructor(
		private readonly dialogService: DialogService,
		private readonly ngZone: NgZone,
	) {
		super({
			scanResults: {},
		});

		this.searchNewBarcodes(this.newBarcode$);
		this.barcodesFilteredArray$
			.pipe(
				pairwise(),
				filter(([a, b]) => a.length !== b.length),
			)
			.subscribe(() => this.beep(BarcodeSearchStatus.scanned));
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
