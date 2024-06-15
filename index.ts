import {AddressLike, BigNumberish, ethers, Signer} from "ethers";

export {OrderBook as IOrderBook, OrderBook__factory as OrderBookFactory} from './typechain';

export enum OrderSide {
    BUY = 0,
    SELL = 1,
}

export enum OrderCloseReason {
    FILLED = 0, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE, EXPIRED_IOK
}

export enum TimeInForce {
    GTC = 0, IOK, FOK
}

export const OrderBookContractName = "zkLite Order Book";
export const OrderBookContractVersion = "v1";
export const OrderBookContractAddress = "";

async function signSubmitOrder(params: {
    signer: ethers.Signer;
    chainId: number;
    side: OrderSide;
    price: BigNumberish;
    amount: BigNumberish;
    pairId: BigNumberish;
    validUntil: BigNumberish;
    tif: TimeInForce;
    networkFee: BigNumberish;
    nonce: BigNumberish;
    orderIdsToCancel: BigNumberish[];
    orderIdsToFill: BigNumberish[];
}) {
    ethers.Signature.from(await params.signer.signTypedData({
        name: OrderBookContractName,
        version: OrderBookContractVersion,
        chainId: params.chainId,
        verifyingContract: OrderBookContractAddress,
    }, {
        "SubmitOrder": [
            {
                "name": "side",
                "type": "uint8"
            }, {
                "name": "price",
                "type": "uint256"
            }, {
                "name": "amount",
                "type": "uint256"
            }, {
                "name": "pairId",
                "type": "uint16"
            }, {
                "name": "validUntil",
                "type": "uint32"
            }, {
                "name": "tif",
                "type": "uint8"
            }, {
                "name": "networkFee",
                "type": "uint256"
            }, {
                "name": "nonce",
                "type": "uint256"
            }, {
                "name": "orderIdsToCancel",
                "type": "uint256[]"
            }, {
                "name": "orderIdsToFill",
                "type": "uint256[]"
            }
        ]
    }, {
        side: params.side,
        price: params.price,
        amount: params.amount,
        pairId: params.pairId,
        validUntil: params.validUntil,
        tif: params.tif,
        networkFee: params.networkFee,
        nonce: params.nonce,
        orderIdsToCancel: params.orderIdsToCancel,
        orderIdsToFill: params.orderIdsToFill
    }));
}
