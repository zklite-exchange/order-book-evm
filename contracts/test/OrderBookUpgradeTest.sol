// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {OrderBook} from "../OrderBook.sol";

import "hardhat/console.sol";

contract OrderBookUpgradeTest is OrderBook {
    /**
    * @custom:oz-upgrades-unsafe-allow constructor
    */
    constructor(string memory name, string memory version) OrderBook(name, version) {
    }

    function onUpgrade() public reinitializer(2) {
        console.log("%s %s", this.getName(), this.getVersion());
    }
}
